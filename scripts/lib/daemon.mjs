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
import { existsSync, mkdirSync, readFileSync, rmSync, unlinkSync, writeFileSync, openSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HOME = join(homedir(), '.justcallme');
export const PID_FILE = join(HOME, 'listener.pid');
export const LOG_FILE = join(HOME, 'listener.log');

const LISTENER = join(dirname(dirname(fileURLToPath(import.meta.url))), 'justcallme-listen.mjs');

/** Is the pid in the pidfile actually alive? Cleans up a stale file. */
export function isListenerRunning() {
  try {
    const pid = Number(readFileSync(PID_FILE, 'utf8').trim());
    if (!pid) return false;
    process.kill(pid, 0); // signal 0 = existence probe, kills nothing
    return pid;
  } catch {
    try { unlinkSync(PID_FILE); } catch { /* already gone */ }
    return false;
  }
}

/** Start the listener detached, logging to LOG_FILE. Returns the pid. */
export function startListener() {
  const running = isListenerRunning();
  if (running) return running;

  mkdirSync(HOME, { recursive: true });
  const log = openSync(LOG_FILE, 'a');
  const child = spawn(process.execPath, [LISTENER], {
    detached: true,
    stdio: ['ignore', log, log],
    windowsHide: true,
  });
  child.unref();
  return child.pid;
}

export function stopListener() {
  const pid = isListenerRunning();
  if (!pid) return false;
  try {
    process.kill(pid);
  } catch {
    /* raced its own exit */
  }
  try { unlinkSync(PID_FILE); } catch { /* listener may have cleaned up */ }
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
    // no elevation, no Task Scheduler permissions to negotiate.
    mkdirSync(windowsStartupDir(), { recursive: true });
    writeFileSync(
      WIN_VBS(),
      `CreateObject("WScript.Shell").Run """${process.execPath}"" ""${LISTENER}""", 0, False\r\n`,
    );
    return 'Startup folder (hidden window)';
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
