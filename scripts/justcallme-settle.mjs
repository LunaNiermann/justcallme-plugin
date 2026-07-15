#!/usr/bin/env node
/**
 * The settle watcher. Spawned detached by the Stop hook; never run by hand.
 *
 * ---------------------------------------------------------------------------
 * The problem this solves
 * ---------------------------------------------------------------------------
 * Claude Code's `Stop` hook fires when Claude finishes *a response* — not when your
 * work is done. If you queued three messages, or Claude finished step one of five,
 * Stop fires anyway. You get phoned about a fragment, then phoned again, then again.
 *
 * There is no "the whole session is finished" hook, and there cannot be: Claude Code
 * doesn't know whether you're about to type something else.
 *
 * So we infer it. Wait a beat, and see if anything else happens.
 *
 *   Stop fires  ->  write a job  ->  detach  ->  wait N seconds
 *                                                  |
 *                       transcript grew? ----------+---------- nothing happened?
 *                       (a new turn started)                   (the session is idle)
 *                              |                                        |
 *                          exit quietly                             RING THE PHONE
 *                   (that turn's own Stop hook
 *                    will arm a fresh watcher)
 *
 * The cost is that the call arrives ~N seconds after the work finishes. Since the
 * entire premise is that you have walked away, that is a rounding error.
 */

import { mkdirSync, readFileSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { resolveCreds } from './lib/creds.mjs';

const SETTLE_SECONDS = Number(process.env.JUSTCALLME_SETTLE_SECONDS ?? 30);
const POLL_MS = 2000;
const DEBUG = process.env.JUSTCALLME_DEBUG === '1';

const log = (...args) => DEBUG && console.error('[justcallme:settle]', ...args);

const jobPath = process.argv[2];
if (!jobPath) process.exit(0);

let job;
try {
  job = JSON.parse(readFileSync(jobPath, 'utf8'));
} catch {
  process.exit(0);
}

const cleanup = () => {
  try {
    unlinkSync(jobPath);
  } catch {
    /* already gone */
  }
};

/** Size+mtime of the transcript, or null if it's unreadable. */
function fingerprint(path) {
  try {
    const s = statSync(path);
    return `${s.size}:${s.mtimeMs}`;
  } catch {
    return null;
  }
}

/** Has a NEWER Stop fired for this session, superseding us? */
function superseded() {
  try {
    return JSON.parse(readFileSync(jobPath, 'utf8')).token !== job.token;
  } catch {
    // The job file is gone — someone else finished or cancelled. Either way, not ours.
    return true;
  }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

log(`waiting ${SETTLE_SECONDS}s to see if the session is really done…`);

const deadline = Date.now() + SETTLE_SECONDS * 1000;

while (Date.now() < deadline) {
  await sleep(POLL_MS);

  if (superseded()) {
    log('a newer turn armed its own watcher — standing down');
    process.exit(0);
  }

  const now = fingerprint(job.transcriptPath);
  if (now && now !== job.fingerprint) {
    // The transcript grew: Claude started another turn, which means you queued
    // something, or it wasn't finished after all. Don't call about a fragment. That
    // turn's Stop hook will arm a fresh watcher when it's genuinely done.
    log('transcript changed — the session is still working, not calling');
    cleanup();
    process.exit(0);
  }
}

// Nothing happened for the whole window. The session is idle. Ring.
log('session settled — calling');

try {
  const res = await fetch(`${job.apiUrl}/notify`, {
    method: 'POST',
    headers: {
      // env → job file → paired key in ~/.justcallme/config.json.
      authorization: `Bearer ${process.env.JUSTCALLME_API_KEY ?? job.apiKey ?? resolveCreds().apiKey}`,
      'content-type': 'application/json',
    },
    body: JSON.stringify(job.body),
    signal: AbortSignal.timeout(20_000),
  });

  const text = await res.text();
  if (res.ok) {
    log('ringing:', text);
  } else if (res.status === 401) {
    // Worth being loud about: a dead key means the phone silently never rings again.
    console.error(
      '[justcallme] API key rejected (401). Mint a new one in the app and update ' +
        'JUSTCALLME_API_KEY. Run `justcallme.mjs doctor` to check.',
    );
  } else if (res.status === 402) {
    // Out of free minutes. This process is detached, so its stderr may go unseen —
    // the durable channel is a notice the SessionStart hook surfaces next time the
    // user opens Claude Code, telling them (and Claude) to run `/callme upgrade`.
    let info = {};
    try {
      info = JSON.parse(text);
    } catch {
      /* keep empty */
    }
    try {
      const dir = join(homedir(), '.justcallme', 'notices');
      mkdirSync(dir, { recursive: true });
      writeFileSync(
        join(dir, `${job.token ?? 'notice'}.json`),
        JSON.stringify({
          type: 'out_of_minutes',
          project: job.body?.task_meta?.project ?? null,
          at: new Date().toISOString(),
          minutes_included: info.minutes_included ?? null,
          period_end: info.period_end ?? null,
        }),
      );
    } catch {
      /* the notice is best-effort */
    }
    console.error(
      '[justcallme] Out of free minutes this cycle — the call was not placed. ' +
        'Run `/callme upgrade` to add minutes.',
    );
  } else {
    log(`API returned ${res.status}: ${text}`);
  }
} catch (err) {
  log('request failed:', err.message);
}

cleanup();
process.exit(0);
