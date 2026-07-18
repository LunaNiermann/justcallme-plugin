#!/usr/bin/env node
/**
 * JustCallMe — the Windows watchdog.
 *
 * macOS and Linux let the OS supervise the listener (launchd KeepAlive, systemd
 * Restart=on-failure): if it crashes, it comes right back. Windows has no per-user
 * equivalent that doesn't mean negotiating Task Scheduler, so the Startup-folder
 * `.vbs` only ever fires once, at login. A listener that crashes an hour later just
 * stays dead — and the phone quietly stops ringing, which is the one failure this
 * whole system exists to prevent.
 *
 * This is that missing supervisor. It does exactly one boring thing on a loop:
 *
 *     if the listener isn't running, start it.
 *
 * It's deliberately far simpler than the listener — no network, no child processes,
 * nothing that spends money — so it is itself far less likely to die. On Windows the
 * Startup `.vbs` launches THIS (see lib/daemon.mjs installAutostart), and `/callme
 * away on` starts it alongside the listener so supervision is live for the current
 * session too, not only after the next reboot.
 *
 * Cross-platform on purpose (it'll run anywhere), but only wired up on Windows —
 * everywhere else the OS already does this job.
 */

import { mkdirSync, unlinkSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { WATCHDOG_PID_FILE, isListenerRunning, startListener } from './lib/daemon.mjs';

// How often to check the listener is alive. A few seconds of downtime after a crash
// is invisible next to the minutes a call is willing to wait; 15s keeps the probe
// cheap. Env override mostly for tests.
const INTERVAL_SECONDS = Number(process.env.JUSTCALLME_WATCHDOG_SECONDS ?? 15);

// Our own pidfile, so `/callme away off` (and a second watchdog) can find and stop us.
try {
  mkdirSync(dirname(WATCHDOG_PID_FILE), { recursive: true });
  writeFileSync(WATCHDOG_PID_FILE, String(process.pid));
} catch {
  /* a read-only home shouldn't stop the watchdog from doing its job */
}
process.on('exit', () => {
  try { unlinkSync(WATCHDOG_PID_FILE); } catch { /* already gone */ }
});

const ts = () => new Date().toLocaleTimeString();
const log = (...args) => console.log(`[${ts()}] watchdog:`, ...args);

/** The whole job: if the listener is down, bring it back. Never throws. */
function ensureListener() {
  try {
    if (isListenerRunning()) return;
    const pid = startListener();
    log(`listener was down — restarted (pid ${pid})`);
  } catch (err) {
    // A transient failure to spawn is not fatal; we'll try again next tick.
    log(`could not restart the listener: ${err.message}`);
  }
}

log(`up — checking the listener every ${INTERVAL_SECONDS}s`);
ensureListener();
setInterval(ensureListener, INTERVAL_SECONDS * 1000);

process.on('SIGINT', () => {
  log('bye');
  process.exit(0);
});
