/**
 * Managing the away-mode listener as a background daemon — start it, keep it
 * across logins, know whether it's alive — so "do it while I'm away" stops
 * meaning "leave a terminal window open forever".
 *
 * Three pieces, all boring on purpose:
 *   - a PIDFILE (~/.justcallme/listener.pid) the listener writes, so anything
 *     can ask "is it running?" with a signal-0 probe
 *   - a detached spawn with output to ~/.justcallme/listener.log
 *   - per-OS login autostart: a hidden .vbs in the Startup folder on Windows
 *     (no admin rights, no console window), a LaunchAgent on macOS, a systemd
 *     user unit on Linux
 */

import { spawn, execSync } from 'node:child_process';
import { closeSync, existsSync, mkdirSync, readFileSync, rmSync, statSync, unlinkSync, writeFileSync, openSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HOME = join(homedir(), '.justcallme');
export const PID_FILE = join(HOME, 'listener.pid');
export const LOG_FILE = join(HOME, 'listener.log');
// The watchdog (Windows only — see below) keeps its own pidfile so it can be found,
// probed, and stopped exactly like the listener is.
export const WATCHDOG_PID_FILE = join(HOME, 'watchdog.pid');
/** The listener re-writes this every poll; the listener's liveness is judged by its
 *  freshness, NOT by whether its pid exists. A recycled PID can't touch this file, so
 *  this can't be fooled the way process.kill(pid, 0) was — that probe reported a dead
 *  daemon as "running" when Windows reassigned its PID, and the watchdog, trusting it,
 *  never restarted the corpse. The watchdog now trusts THIS instead. */
export const HEARTBEAT_FILE = join(HOME, 'daemon.heartbeat');
/** The listener polls every ~5s; give it a wide margin (a slow poll can be ~15s) before
 *  we call it dead. */
const HEARTBEAT_STALE_MS = 30_000;

const HOOKS_DIR = dirname(dirname(fileURLToPath(import.meta.url)));
const LISTENER = join(HOOKS_DIR, 'justcallme-listen.mjs');
const WATCHDOG = join(HOOKS_DIR, 'justcallme-watchdog.mjs');

/** Is the pid in `pidFile` actually alive? Cleans up a stale file. Returns the pid or false. */
function isAlive(pidFile) {
  try {
    const pid = Number(readFileSync(pidFile, 'utf8').trim());
    if (!pid) return false;
    process.kill(pid, 0); // signal 0 = existence probe, kills nothing
    return pid;
  } catch {
    try { unlinkSync(pidFile); } catch { /* already gone */ }
    return false;
  }
}

/**
 * Spawn one of our scripts detached, logging to LOG_FILE, and stamp its pidfile
 * immediately.
 *
 * That eager write matters: the listener also writes its own pidfile on startup, but
 * only *after* Node boots. Between spawn and that write there's a gap where
 * isAlive() reads false — and the watchdog, polling in that gap, would spawn a SECOND
 * listener. Two listeners in one repo can run two instructions at once, which is the
 * exact "bad day" the single-flight guard exists to prevent. Writing the pid here,
 * synchronously, closes the gap. The child later rewrites the same value; harmless.
 */
function spawnDetached(script, pidFile) {
  mkdirSync(HOME, { recursive: true });
  const log = openSync(LOG_FILE, 'a');

  // The daemon must behave identically whether started here or at login — and
  // at login it has NO JUSTCALLME_* environment. So strip that env here too:
  // otherwise it inherits whatever shell spawned it (a stale key exported
  // months ago outranks the freshly paired one in config.json, and the daemon
  // sits there polling 401s). Config.json is the daemon's single source.
  const env = Object.fromEntries(
    Object.entries(process.env).filter(([k]) => !k.startsWith('JUSTCALLME_')),
  );

  const child = spawn(process.execPath, [script], {
    detached: true,
    stdio: ['ignore', log, log],
    windowsHide: true,
    env,
  });
  child.unref();
  // The child dup'd the log fd into its own stdio; close our copy so a long-lived
  // caller (the watchdog, which respawns on every crash) doesn't leak one per restart.
  try { closeSync(log); } catch { /* already closed */ }
  try { writeFileSync(pidFile, String(child.pid)); } catch { /* read-only home; child writes it too */ }
  return child.pid;
}

/**
 * Is the listener actually alive? Judged by the heartbeat file's freshness — a running
 * daemon rewrites it every poll (see touchHeartbeat in justcallme-listen.mjs). This is
 * deliberately NOT the pid-based isAlive() the watchdog uses on itself: a listener that
 * died and had its PID recycled onto an unrelated process would pass process.kill(pid, 0)
 * and be reported "running" forever, so the watchdog would never restart it and the phone
 * would go quiet. A recycled PID can't forge a fresh heartbeat, so this can't be fooled.
 * Returns the pid (truthy) when alive, false when not — cleaning up a stale pidfile.
 */
export function isListenerRunning() {
  try {
    if (Date.now() - statSync(HEARTBEAT_FILE).mtimeMs < HEARTBEAT_STALE_MS) {
      try {
        return Number(readFileSync(PID_FILE, 'utf8').trim()) || true;
      } catch {
        return true; // fresh heartbeat but no pidfile — still clearly alive
      }
    }
  } catch {
    /* no heartbeat file — never started, or long dead */
  }
  try { unlinkSync(PID_FILE); } catch { /* already gone */ }
  return false;
}

/** Start the listener detached, logging to LOG_FILE. Returns the pid. */
export function startListener() {
  const running = isListenerRunning();
  if (running) return running;
  return spawnDetached(LISTENER, PID_FILE);
}

export function stopListener() {
  const pid = isListenerRunning();
  if (!pid) return false;
  // isListenerRunning() can return the boolean `true` (fresh heartbeat, but the pidfile
  // vanished) — we know it's alive but not which pid, so we cannot signal it. Only kill a
  // real number; never let `true` coerce to process.kill(1). The killed listener's exit
  // handler clears both its pidfile and heartbeat.
  if (typeof pid === 'number') {
    try {
      process.kill(pid);
    } catch {
      /* raced its own exit */
    }
  }
  try { unlinkSync(PID_FILE); } catch { /* listener may have cleaned up */ }
  return true;
}

/**
 * Make sure the helper is up and set to come back after a login. Idempotent and cheap:
 * the SessionStart hook calls this on every session, so a fresh install needs no command,
 * and a helper that died is revived the moment you next touch Claude Code. On Windows it
 * also starts the watchdog (the OS supervisor the other platforms get for free), so a
 * mid-session crash is recovered even before the next login. Returns the listener pid.
 *
 * "Running" here is decoupled from "allowed to execute" on purpose — the helper just
 * polls and heartbeats (harmless); whether it RUNS an instruction unattended is gated by
 * the account's execution_mode, not by whether the process is alive.
 */
export function ensureRunning() {
  const pid = startListener(); // no-op if already alive
  try {
    if (process.platform === 'win32') startWatchdog(); // no-op if already alive
  } catch {
    /* the watchdog is a nicety; a machine that won't spawn it must not break the session */
  }
  try {
    if (!isAutostartInstalled()) installAutostart();
  } catch {
    /* autostart is a nicety; a locked-down machine must not break the session */
  }
  return pid;
}

// ---------------------------------------------------------------------------
// Windows watchdog
// ---------------------------------------------------------------------------
// macOS and Linux hand supervision to the OS: the LaunchAgent below sets
// KeepAlive, the systemd unit sets Restart=on-failure — a crashed listener comes
// straight back. Windows has no per-user equivalent without negotiating Task
// Scheduler, so a `.vbs` in Startup only ever fires ONCE, at login: if the listener
// then crashes mid-session, nothing brings it back until the next reboot, and the
// phone silently stops ringing. The watchdog is that missing supervisor — a tiny
// process that restarts the listener whenever it finds it down. See
// justcallme-watchdog.mjs. It's wired only on Windows; elsewhere it's dead weight.

/** Is the watchdog alive? Returns its pid or false. */
export function isWatchdogRunning() {
  return isAlive(WATCHDOG_PID_FILE);
}

/** Start the watchdog detached. Returns the pid (or an already-running one). */
export function startWatchdog() {
  const running = isWatchdogRunning();
  if (running) return running;
  return spawnDetached(WATCHDOG, WATCHDOG_PID_FILE);
}

export function stopWatchdog() {
  const pid = isWatchdogRunning();
  if (!pid) return false;
  try {
    process.kill(pid);
  } catch {
    /* raced its own exit */
  }
  try { unlinkSync(WATCHDOG_PID_FILE); } catch { /* watchdog may have cleaned up */ }
  return true;
}

// ---------------------------------------------------------------------------
// Login autostart
// ---------------------------------------------------------------------------

function windowsStartupDir() {
  return join(
    process.env.APPDATA ?? join(homedir(), 'AppData', 'Roaming'),
    'Microsoft', 'Windows', 'Start Menu', 'Programs', 'Startup',
  );
}

const WIN_VBS = () => join(windowsStartupDir(), 'justcallme-listener.vbs');
const MAC_PLIST = () => join(homedir(), 'Library', 'LaunchAgents', 'me.getjustcall.listener.plist');
const LINUX_UNIT = () => join(homedir(), '.config', 'systemd', 'user', 'justcallme-listener.service');

export function isAutostartInstalled() {
  if (process.platform === 'win32') return existsSync(WIN_VBS());
  if (process.platform === 'darwin') return existsSync(MAC_PLIST());
  return existsSync(LINUX_UNIT());
}

/** Register the listener to start at login. No admin rights anywhere. */
export function installAutostart() {
  if (process.platform === 'win32') {
    // A .vbs in the per-user Startup folder: runs node hidden (window style 0),
    // no elevation, no Task Scheduler permissions to negotiate. It launches the
    // WATCHDOG, not the listener directly — the watchdog starts the listener and
    // then keeps restarting it if it dies, giving Windows the crash-recovery that
    // launchd (KeepAlive) and systemd (Restart=on-failure) already provide below.
    mkdirSync(windowsStartupDir(), { recursive: true });
    writeFileSync(
      WIN_VBS(),
      `CreateObject("WScript.Shell").Run """${process.execPath}"" ""${WATCHDOG}""", 0, False\r\n`,
    );
    return 'Startup folder (hidden window, watchdog-supervised)';
  }

  if (process.platform === 'darwin') {
    mkdirSync(dirname(MAC_PLIST()), { recursive: true });
    writeFileSync(
      MAC_PLIST(),
      `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>me.getjustcall.listener</string>
  <key>ProgramArguments</key>
  <array><string>${process.execPath}</string><string>${LISTENER}</string></array>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>StandardOutPath</key><string>${LOG_FILE}</string>
  <key>StandardErrorPath</key><string>${LOG_FILE}</string>
</dict>
</plist>
`,
    );
    try {
      execSync(`launchctl load -w "${MAC_PLIST()}"`, { stdio: 'ignore' });
    } catch {
      /* already loaded */
    }
    return 'LaunchAgent (launchd keeps it alive)';
  }

  mkdirSync(dirname(LINUX_UNIT()), { recursive: true });
  writeFileSync(
    LINUX_UNIT(),
    `[Unit]
Description=Just Call Me away-mode listener

[Service]
ExecStart=${process.execPath} ${LISTENER}
Restart=on-failure

[Install]
WantedBy=default.target
`,
  );
  try {
    execSync('systemctl --user daemon-reload && systemctl --user enable --now justcallme-listener', {
      stdio: 'ignore',
      shell: '/bin/sh',
    });
    return 'systemd user unit';
  } catch {
    return 'systemd unit written (enable it with: systemctl --user enable --now justcallme-listener)';
  }
}

export function uninstallAutostart() {
  try {
    if (process.platform === 'win32') rmSync(WIN_VBS(), { force: true });
    else if (process.platform === 'darwin') {
      try { execSync(`launchctl unload -w "${MAC_PLIST()}"`, { stdio: 'ignore' }); } catch { /* not loaded */ }
      rmSync(MAC_PLIST(), { force: true });
    } else {
      try {
        execSync('systemctl --user disable --now justcallme-listener', { stdio: 'ignore', shell: '/bin/sh' });
      } catch { /* not enabled */ }
      rmSync(LINUX_UNIT(), { force: true });
    }
  } catch {
    /* best effort — nothing here is worth failing the command over */
  }
}
