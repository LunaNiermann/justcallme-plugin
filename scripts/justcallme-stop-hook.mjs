#!/usr/bin/env node
/**
 * JustCallMe — Claude Code `Stop` hook.
 *
 * Fires when Claude Code finishes responding. If the task took long enough to be
 * worth a phone call, POSTs a summary to the orchestration API, which dispatches
 * the voice agent and rings your phone.
 *
 * Install: see hooks/README.md. Configure with env vars:
 *
 *   JUSTCALLME_API_URL       required — https://<your-api>.onrender.com
 *   JUSTCALLME_API_KEY       required — the jcm_… key from the app
 *   JUSTCALLME_MIN_SECONDS   optional — don't call for tasks shorter than this
 *                                       (default 600 = 10 min; set 0 to always call)
 *   JUSTCALLME_DEBUG         optional — set to 1 to log what it's doing
 *
 * Hooks must never break the user's session, so this exits 0 no matter what.
 * A failed phone call is an annoyance; a hook that hard-fails a Claude Code run
 * is a much bigger problem than the one it was solving.
 */

import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { forSpeech, readTranscript, truncateForSpeech } from './lib/summary.mjs';
import { loadConfig, saveConfig, shouldCall } from './lib/config.mjs';
import { resolveCreds } from './lib/creds.mjs';

const SETTLE_SCRIPT = join(dirname(fileURLToPath(import.meta.url)), 'justcallme-settle.mjs');

// Env wins; ~/.justcallme/config.json (written by `/callme pair`) is the fallback.
const { apiUrl: API_URL, apiKey: API_KEY } = resolveCreds();
const MIN_SECONDS = Number(process.env.JUSTCALLME_MIN_SECONDS ?? 600);
const DEBUG = process.env.JUSTCALLME_DEBUG === '1';

// Set by `justcallme listen` on the runs *it* spawns, so the chain can be
// counted and eventually cut off. Absent (0) when you started the task yourself.
const CHAIN_DEPTH = Number(process.env.JUSTCALLME_CHAIN_DEPTH ?? 0);

const log = (...args) => DEBUG && console.error('[justcallme]', ...args);

/** Never fail the session. Ever. */
function bail(reason) {
  log('skipping:', reason);
  process.exit(0);
}

// --- read the hook payload from stdin --------------------------------------
// Claude Code pipes a JSON object in. The fields we care about:
//   session_id, transcript_path, cwd, stop_hook_active
let payload = {};
try {
  const raw = readFileSync(0, 'utf8');
  payload = raw.trim() ? JSON.parse(raw) : {};
} catch (err) {
  bail(`could not parse stdin: ${err.message}`);
}

// Guard against the obvious infinite loop: if Claude Code is already re-running
// because of a Stop hook, don't trigger another one.
if (payload.stop_hook_active) bail('stop_hook_active — already in a stop hook');

if (!API_URL || !API_KEY) {
  bail('no API credentials — set JUSTCALLME_API_URL / JUSTCALLME_API_KEY or run `/callme pair`');
}

// --- reconstruct what happened from the transcript --------------------------
const EMPTY = { turnSeconds: 0, sessionSeconds: 0, lastAssistantText: null };

function loadTranscript(path) {
  if (!path) return EMPTY;
  try {
    return readTranscript(readFileSync(path, 'utf8').split('\n').filter(Boolean));
  } catch (err) {
    log('could not read transcript:', err.message);
    return EMPTY;
  }
}

// turnSeconds, NOT sessionSeconds. The transcript holds the whole session, so
// measuring from its first line told you how long Claude Code had been open — hours —
// and every task cleared every threshold. See lib/summary.mjs.
const { turnSeconds, sessionSeconds, lastAssistantText } = loadTranscript(payload.transcript_path);

// --- should we call at all? -------------------------------------------------
// The rules live in ~/.justcallme/config.json and are driven by `/callme`. See
// lib/config.mjs.
//
// JUSTCALLME_MIN_SECONDS still overrides everything when it's set explicitly — a CI
// box or a shared machine needs to be able to force the behaviour it wants without
// touching a user's config file.
// JUSTCALLME_PROJECT is set by the listener when it runs work in a WORKTREE — whose
// directory is named after a slug, not your repo. Without the override the hook would
// see an unknown project and never call you back, which is exactly the call you're
// waiting for.
const project = process.env.JUSTCALLME_PROJECT || (payload.cwd ? basename(payload.cwd) : 'unknown');
const config = loadConfig();

if (process.env.JUSTCALLME_MIN_SECONDS !== undefined) {
  // Explicit env override: the old, simple behaviour.
  if (turnSeconds < MIN_SECONDS) {
    bail(`task ran ${turnSeconds}s, below JUSTCALLME_MIN_SECONDS=${MIN_SECONDS}`);
  }
} else {
  const verdict = shouldCall({ config, project, durationSeconds: turnSeconds });
  if (!verdict.call) bail(verdict.reason);
  log(`will call: ${verdict.reason}`);

  // A one-shot fires exactly once. Clear it BEFORE anything else: if the call later
  // fails we'd rather lose one than have a stale arm ring you for every task in this
  // project until you notice.
  if (verdict.consumeOnce) {
    config.once = null;
    saveConfig(config);
  }
}

if (!lastAssistantText) bail('no final assistant message found in transcript');

// --- shape it for the ear, not the eye --------------------------------------
// See lib/summary.mjs: markdown read aloud is unlistenable, and the stripping has
// to happen here rather than in the agent's prompt.
const summary = truncateForSpeech(forSpeech(lastAssistantText));

// --- arm the settle watcher, don't call yet ---------------------------------
//
// The Stop hook fires when Claude finishes A RESPONSE — not when your work is done.
// Queue three messages and it fires three times; you get phoned about a fragment,
// then phoned again. There is no "session finished" hook and there cannot be, because
// Claude Code doesn't know whether you're about to type something else.
//
// So we infer it: hand the job to a detached watcher, which waits and sees whether
// anything else happens. If the transcript grows, another turn started and it stands
// down (that turn will arm its own watcher when it's genuinely done). If nothing
// happens for the whole window, the session is idle — and *that's* when the phone
// rings. See justcallme-settle.mjs.
const body = {
  task_summary: summary,
  chain_depth: CHAIN_DEPTH,
  task_meta: {
    cwd: payload.cwd ?? null,
    project: payload.cwd ? basename(payload.cwd) : null,
    session_id: payload.session_id ?? null,
    transcript_path: payload.transcript_path ?? null,
    duration_seconds: turnSeconds,
    session_seconds: sessionSeconds,
    source: 'claude-code-stop-hook',
  },
};

const jobDir = join(homedir(), '.justcallme', 'pending');
mkdirSync(jobDir, { recursive: true });

// One job per session. A newer Stop overwrites it, and the older watcher notices its
// token has changed and stands down — so rapid-fire turns can't stack up watchers.
const jobPath = join(jobDir, `${(payload.session_id ?? 'unknown').replace(/[^\w-]/g, '')}.json`);

let fingerprint = null;
try {
  const s = statSync(payload.transcript_path);
  fingerprint = `${s.size}:${s.mtimeMs}`;
} catch {
  /* no transcript to watch; the watcher will just wait out its window */
}

writeFileSync(
  jobPath,
  JSON.stringify({
    token: randomUUID(),
    apiUrl: API_URL,
    transcriptPath: payload.transcript_path ?? null,
    fingerprint,
    body,
  }),
);

// Detached, stdio ignored, unref'd: the hook must return IMMEDIATELY. Claude Code
// waits on its hooks, and blocking the session for 30 seconds to decide whether to
// make a phone call would be an absurd trade.
const child = spawn(process.execPath, [SETTLE_SCRIPT, jobPath], {
  detached: true,
  stdio: 'ignore',
  env: process.env,
});
child.unref();

log(
  `armed (${turnSeconds}s task, ${summary.length} chars) — calling in ` +
    `${process.env.JUSTCALLME_SETTLE_SECONDS ?? 30}s unless the session keeps working`,
);

process.exit(0);
