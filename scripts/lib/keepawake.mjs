/**
 * Keep the machine awake while a call could land on it.
 *
 * The whole promise is "leave it running and your phone rings when the work is
 * done." That promise breaks the moment the laptop lid closes or the desktop hits
 * its idle-sleep timer: the listener stops polling, a user taps "Call a project"
 * and nothing answers, a callback instruction sits in the queue for hours. The
 * daemon was up the entire time — the OS just put the whole machine to sleep
 * underneath it.
 *
 * So while the listener is actually serving a project (armed — at least one dir in
 * the away allowlist), we hold a wake lock. Not the display — the screen is welcome
 * to turn off — just the *system*, so polling keeps happening and an inbound call
 * can be answered. When nothing is armed, we drop the lock, so a paired-but-idle
 * machine still sleeps normally and a laptop on battery isn't held awake for nothing.
 *
 * ---------------------------------------------------------------------------
 * How, without a native module
 * ---------------------------------------------------------------------------
 * Each OS already ships a tool that does exactly this; we spawn it and let it run:
 *
 *   - Windows : a hidden PowerShell that calls SetThreadExecutionState(
 *               ES_CONTINUOUS | ES_SYSTEM_REQUIRED). The flag lives on that thread
 *               for as long as the process is alive; when it exits, Windows clears
 *               it automatically.
 *   - macOS   : `caffeinate -i` — prevent idle sleep.
 *   - Linux   : `systemd-inhibit --what=sleep:idle` holding a sleep lock.
 *
 * The important trick: the helper is tied to the LISTENER'S pid, so it releases the
 * lock the instant the daemon goes away — even if the daemon *crashes* and never
 * runs a shutdown handler. caffeinate has `-w <pid>` for exactly this; the others
 * we wrap in a `wait for pid to vanish` so the behaviour is identical everywhere. A
 * leaked wake lock (machine that never sleeps again because a dead daemon forgot to
 * let go) is the one failure mode worse than the one we're fixing.
 *
 * Everything here is best-effort: a platform we don't recognise, or a helper that
 * won't spawn, must never take the daemon down. It just means the machine keeps its
 * normal sleep behaviour — the pre-existing state, not a regression.
 */

import { spawn } from 'node:child_process';

// SetThreadExecutionState flags (winbase.h). ES_CONTINUOUS makes the request sticky
// for the calling thread; ES_SYSTEM_REQUIRED forces the system-idle timer to reset.
// We deliberately do NOT set ES_DISPLAY_REQUIRED — keeping the screen lit all night
// is not the job, and it drains a laptop for no reason.
const ES_CONTINUOUS = 0x80000000;
const ES_SYSTEM_REQUIRED = 0x00000001;

/**
 * Build the per-OS keep-awake command that stays alive until `pid` exits.
 *
 * Pure and side-effect-free so it can be unit-tested without spawning anything.
 * Returns `{ command, args }` to spawn, or `null` when we have no way to hold a
 * lock on this platform (unknown OS, or a nonsense pid).
 *
 * @param {NodeJS.Platform} platform  process.platform
 * @param {number} pid                the daemon pid the lock is bound to
 * @returns {{ command: string, args: string[] } | null}
 */
export function keepAwakeCommand(platform, pid) {
  // A bad pid would make the helper either watch nothing (and hold the lock forever)
  // or, worse, wait on some unrelated recycled pid. Refuse rather than guess.
  if (!Number.isInteger(pid) || pid <= 0) return null;

  if (platform === 'darwin') {
    // -i: prevent idle sleep. -w: exit (releasing the lock) when pid exits.
    return { command: 'caffeinate', args: ['-i', '-w', String(pid)] };
  }

  if (platform === 'linux') {
    // Hold a sleep+idle inhibitor for as long as the daemon lives. `kill -0` is a
    // liveness probe that signals nothing; when it fails, the daemon is gone, the
    // loop ends, the command returns, and systemd-inhibit drops the lock.
    return {
      command: 'systemd-inhibit',
      args: [
        '--what=sleep:idle',
        '--who=Just Call Me',
        '--why=Waiting for a call',
        '--mode=block',
        'sh',
        '-c',
        `while kill -0 ${pid} 2>/dev/null; do sleep 5; done`,
      ],
    };
  }

  if (platform === 'win32') {
    // A tiny PowerShell that pins the wake lock, waits for the daemon to exit, then
    // clears it. Passed as a Base64 -EncodedCommand (UTF-16LE, as PowerShell wants)
    // so none of the quotes or semicolons below have to survive a trip through the
    // Windows command-line quoting rules.
    const script = [
      `$p = Add-Type -MemberDefinition '[DllImport("kernel32.dll")] public static extern uint SetThreadExecutionState(uint e);' -Name Power -Namespace JustCallMe -PassThru`,
      // ES_CONTINUOUS | ES_SYSTEM_REQUIRED — hold the system awake (not the display).
      `[void]$p::SetThreadExecutionState(${(ES_CONTINUOUS | ES_SYSTEM_REQUIRED) >>> 0})`,
      // Block until the daemon exits. -ErrorAction SilentlyContinue: if it's already
      // gone we fall straight through to the release below.
      `try { Wait-Process -Id ${pid} -ErrorAction SilentlyContinue } catch {}`,
      // ES_CONTINUOUS on its own clears the request. (Process exit would clear it too,
      // but being explicit costs nothing.)
      `[void]$p::SetThreadExecutionState(${ES_CONTINUOUS >>> 0})`,
    ].join('\n');

    return {
      command: 'powershell.exe',
      args: [
        '-NoProfile',
        '-NonInteractive',
        '-WindowStyle',
        'Hidden',
        '-EncodedCommand',
        Buffer.from(script, 'utf16le').toString('base64'),
      ],
    };
  }

  return null;
}

// The single live helper process (or null), plus a latch so a platform that can't
// spawn one doesn't get retried on every poll forever.
let helper = null;
let unavailable = false;

/** Acquire the wake lock, bound to `pid` (the daemon). Idempotent; safe to call every poll. */
export function keepSystemAwake(pid = process.pid) {
  if (helper || unavailable) return;

  const spec = keepAwakeCommand(process.platform, pid);
  if (!spec) {
    unavailable = true; // nothing we can do here — stop trying.
    return;
  }

  try {
    // Detached + unref so the helper never keeps the daemon alive; we still hold the
    // handle so we can drop the lock deliberately when we disarm.
    const child = spawn(spec.command, spec.args, {
      detached: true,
      stdio: 'ignore',
      windowsHide: true,
    });
    // A missing binary (no caffeinate, no systemd-inhibit) surfaces here, async.
    child.on('error', () => {
      helper = null;
      unavailable = true;
    });
    child.on('exit', () => {
      // It exited on its own (the daemon it was watching went away, or it was killed).
      // Clear the handle so a re-arm can start a fresh one.
      if (helper === child) helper = null;
    });
    child.unref();
    helper = child;
  } catch {
    // Synchronous spawn failure (e.g. command not found on some shells). Give up quietly.
    unavailable = true;
  }
}

/** Drop the wake lock now — machine may sleep again. Idempotent. */
export function releaseSystemAwake() {
  if (!helper) return;
  try {
    helper.kill();
  } catch {
    /* already gone */
  }
  helper = null;
}

/**
 * One call that reflects "should we be holding the machine awake right now?".
 * Pass `true` while armed, `false` when nothing is being served.
 */
export function syncKeepAwake(shouldStayAwake, pid = process.pid) {
  if (shouldStayAwake) keepSystemAwake(pid);
  else releaseSystemAwake();
}
