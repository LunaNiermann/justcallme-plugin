#!/usr/bin/env node
/**
 * JustCallMe — OpenAI Codex CLI `notify` program.
 *
 * Codex's analogue of the Claude Code Stop hook. Configure it in ~/.codex/config.toml:
 *
 *   notify = ["node", "/absolute/path/to/justcallme/hooks/justcallme-codex-notify.mjs"]
 *
 * Codex runs it when it finishes an agent turn ("agent-turn-complete"), passing the event
 * as a single JSON argument:
 *
 *   { "type": "agent-turn-complete", "thread-id": "...", "turn-id": "...",
 *     "cwd": "/path", "input-messages": [...], "last-assistant-message": "..." }
 *
 * From there it is the SAME pipeline as the Claude hook: shape the assistant's final
 * message for the ear, decide whether it's worth a call, and hand a job to the settle
 * watcher (which waits out the idle window so a burst of turns rings you once, not thrice).
 * Only the front half — the payload shape and where the duration comes from — is Codex-
 * specific; everything downstream (settle → /notify → agent → phone) is shared and unchanged.
 *
 * Exits 0 on every path: a notify program that errors must never disturb Codex.
 */

import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdirSync, statSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { forSpeech, truncateForSpeech } from './lib/summary.mjs';
import { loadConfig, saveConfig, shouldCall } from './lib/config.mjs';
import { resolveCreds } from './lib/creds.mjs';
import { codexTiming } from './lib/codex-session.mjs';

const SETTLE_SCRIPT = join(dirname(fileURLToPath(import.meta.url)), 'justcallme-settle.mjs');
const { apiUrl: API_URL, apiKey: API_KEY } = resolveCreds();
const DEBUG = process.env.JUSTCALLME_DEBUG === '1';
const CHAIN_DEPTH = Number(process.env.JUSTCALLME_CHAIN_DEPTH ?? 0);

const log = (...args) => DEBUG && console.error('[justcallme-codex]', ...args);
function bail(reason) {
  log('skipping:', reason);
  process.exit(0);
}

// --- parse Codex's event (a single JSON argv) ------------------------------
let ev = {};
try {
  ev = JSON.parse(process.argv[2] ?? '{}');
} catch (err) {
  bail(`could not parse the notify argument: ${err.message}`);
}

// Codex may grow other event types; only a completed turn is worth a call.
if (ev.type && ev.type !== 'agent-turn-complete') bail(`event '${ev.type}' is not a turn completion`);

// Set by the away-mode listener on the runs IT spawns, so a declined call-back stays quiet.
if (process.env.JUSTCALLME_SUPPRESS_CALLBACK) bail('callback suppressed for this run');
if (!API_URL || !API_KEY) bail('no API credentials — run `/callme pair` or set JUSTCALLME_API_URL/KEY');

// Field names are hyphenated in Codex's payload; tolerate snake_case too, just in case.
const cwd = ev.cwd ?? process.cwd();
const threadId = ev['thread-id'] ?? ev.thread_id ?? null;
const lastAssistant = ev['last-assistant-message'] ?? ev.last_assistant_message ?? '';
if (!lastAssistant.trim()) bail('no last-assistant-message in the event');

// JUSTCALLME_PROJECT is set by the listener when a run happens in a worktree (named after a
// slug, not the repo); without it the hook would see an unknown project and never call back.
const project = process.env.JUSTCALLME_PROJECT || basename(cwd);

// Duration for the threshold, read from Codex's own rollout file. null = couldn't tell.
const { turnSeconds, sessionSeconds, rolloutPath } = codexTiming(threadId);

// --- should we call at all? ------------------------------------------------
const config = loadConfig();
if (process.env.JUSTCALLME_MIN_SECONDS !== undefined) {
  const min = Number(process.env.JUSTCALLME_MIN_SECONDS);
  if (turnSeconds !== null && turnSeconds < min) bail(`turn ran ${turnSeconds}s, below ${min}`);
} else {
  // Unknown duration must not silently suppress a call — the settle idle-gate below is the
  // real spam guard, so treat "unknown" as "long enough" and let it through.
  const durationSeconds = turnSeconds ?? Number.MAX_SAFE_INTEGER;
  const verdict = shouldCall({ config, project, durationSeconds });
  if (!verdict.call) bail(verdict.reason);
  log(`will call: ${verdict.reason}`);
  if (verdict.consumeOnce) {
    config.once = null;
    saveConfig(config);
  }
}

// --- shape it for the ear, arm the settle watcher --------------------------
const summary = truncateForSpeech(forSpeech(lastAssistant));
const awayFlag = config.projects?.[project]?.away;

const body = {
  task_summary: summary,
  chain_depth: CHAIN_DEPTH,
  task_meta: {
    cwd: cwd ?? null,
    project,
    thread_id: threadId,
    duration_seconds: turnSeconds,
    session_seconds: sessionSeconds,
    // Lets the backend (and the away-mode listener) tell agents apart — it drives which
    // CLI a confirmed away-instruction is run with. See justcallme-listen.mjs.
    source: 'codex-notify',
    agent: 'codex',
    ...(awayFlag === true ? { execution_mode: 'auto' } : {}),
    ...(awayFlag === false ? { execution_mode: 'ask' } : {}),
  },
};

const jobDir = join(homedir(), '.justcallme', 'pending');
mkdirSync(jobDir, { recursive: true });
// One job per thread: a newer turn overwrites it and the older watcher stands down.
const jobPath = join(jobDir, `codex-${String(threadId ?? 'unknown').replace(/[^\w-]/g, '')}.json`);

// The settle watcher watches this file's size+mtime to see if Codex kept working. The
// rollout file is Codex's live session log, so it grows on the next turn — exactly the
// signal settle needs. null when we couldn't find it (settle just waits out its window).
let fingerprint = null;
if (rolloutPath) {
  try {
    const s = statSync(rolloutPath);
    fingerprint = `${s.size}:${s.mtimeMs}`;
  } catch {
    /* it moved/compressed; the watcher will just wait */
  }
}

writeFileSync(
  jobPath,
  JSON.stringify({
    token: randomUUID(),
    apiUrl: API_URL,
    transcriptPath: rolloutPath,
    fingerprint,
    body,
  }),
);

const child = spawn(process.execPath, [SETTLE_SCRIPT, jobPath], {
  detached: true,
  stdio: 'ignore',
  env: process.env,
});
child.unref();

log(
  `armed (turn ${turnSeconds}s, ${summary.length} chars) — calling in ` +
    `${process.env.JUSTCALLME_SETTLE_SECONDS ?? 30}s unless Codex keeps working`,
);

process.exit(0);
