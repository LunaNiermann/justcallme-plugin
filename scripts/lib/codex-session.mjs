/**
 * Timing for a Codex run, read from its rollout (session) files.
 *
 * Codex's `notify` payload tells us WHAT finished (the last assistant message) and WHERE
 * (cwd), but not how LONG the turn took — and the threshold ("don't ring for quick tasks")
 * needs a duration. Codex persists every session as newline-delimited JSON at
 * `~/.codex/sessions/YYYY/MM/DD/rollout-*.jsonl`, one event per line, each with a UTC
 * `timestamp`. We read that to recover the turn length.
 *
 * We measure the CURRENT TURN, not the whole session: time since the last user/developer
 * message. Measuring from the first line would report how long the Codex session had been
 * open — often hours — so every task would clear every threshold (the exact trap the Claude
 * transcript reader documents). Line schema (Codex v0.13x):
 *   { "timestamp": "<ISO>", "type": "response_item",
 *     "payload": { "type": "message", "role": "user"|"developer"|"assistant", ... } }
 *
 * Everything here is best-effort and defensive: the format drifts across Codex versions and
 * archived sessions are `.zst`-compressed (unreadable without a dependency). On any doubt we
 * return nulls, and the caller treats "unknown duration" as "ring" rather than swallow the
 * call — missing a call is the one failure this product exists to prevent.
 */

import { readdirSync, readFileSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

const SESSIONS_DIR = join(homedir(), '.codex', 'sessions');

/** Collect readable (plain .jsonl) rollout files with their mtime. Bounded, defensive walk. */
function findRolloutFiles(dir, out, depth) {
  if (depth > 5) return;
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const e of entries) {
    const full = join(dir, e.name);
    if (e.isDirectory()) {
      findRolloutFiles(full, out, depth + 1);
    } else if (e.name.startsWith('rollout-') && e.name.endsWith('.jsonl')) {
      // .jsonl only — a .jsonl.zst archive we can't read without a zstd dependency.
      try {
        out.push({ path: full, mtimeMs: statSync(full).mtimeMs });
      } catch {
        /* vanished between readdir and stat */
      }
    }
  }
}

/**
 * Best-effort timing for the Codex turn that just completed.
 *
 * @param {string|null} threadId  the notify payload's thread-id, used to pick the right
 *                                rollout file when several sessions exist; falls back to the
 *                                most-recently-written file.
 * @returns {{ turnSeconds: number|null, sessionSeconds: number|null, rolloutPath: string|null }}
 */
export function codexTiming(threadId) {
  try {
    const files = [];
    findRolloutFiles(SESSIONS_DIR, files, 0);
    if (!files.length) return { turnSeconds: null, sessionSeconds: null, rolloutPath: null };

    // Prefer the file whose name carries this thread id (rollout names embed the session
    // uuid); otherwise the newest file is the session that just wrote the completing turn.
    let pick = threadId ? files.find((f) => f.path.includes(threadId)) : null;
    if (!pick) pick = files.sort((a, b) => b.mtimeMs - a.mtimeMs)[0];

    const lines = readFileSync(pick.path, 'utf8').split('\n');
    let firstTs = null;
    let lastUserTs = null;
    for (const line of lines) {
      if (!line) continue;
      let e;
      try {
        e = JSON.parse(line);
      } catch {
        continue;
      }
      const ts = Date.parse(e?.timestamp);
      if (!Number.isFinite(ts)) continue;
      if (firstTs === null) firstTs = ts;
      const p = e?.payload;
      if (p?.type === 'message' && (p.role === 'user' || p.role === 'developer')) {
        lastUserTs = ts; // start of the latest turn
      }
    }

    const now = Date.now();
    const sessionSeconds = firstTs === null ? null : Math.max(0, Math.round((now - firstTs) / 1000));
    // Turn = since the last human message. If we couldn't spot one, fall back to session
    // length rather than inventing a small number that would suppress a real call.
    const turnSeconds =
      lastUserTs === null ? sessionSeconds : Math.max(0, Math.round((now - lastUserTs) / 1000));

    return { turnSeconds, sessionSeconds, rolloutPath: pick.path };
  } catch {
    return { turnSeconds: null, sessionSeconds: null, rolloutPath: null };
  }
}
