/**
 * Pop something that STAYS ON SCREEN with a summary of an away-mode run.
 *
 * The toast (see notify-desktop.mjs) is a glance that vanishes; this is the "it's still
 * here when you sit back down" companion. When the listener finishes a call instruction
 * it shows one of these with what the agent did and where it landed, and leaves it up
 * until you dismiss it — so a branch built while you were away doesn't flash past and
 * disappear before you're back at the desk.
 *
 *   - Windows: a persistent console window (`cmd /k`), left at a prompt so it stays.
 *   - macOS:   an `osascript` dialog. A `display notification` would fade like the toast,
 *              so we use `display dialog`, which sits on screen until you click it — the
 *              same "still there when you return" property the Windows window has, with no
 *              dependency to install (osascript ships with macOS).
 *   - Linux:   no-op for now (the toast still fires); a persistent-window equivalent there
 *              would be another mechanism and isn't wired yet.
 *
 * Text is handed over verbatim — via a temp file + `type` on Windows, via the environment
 * (`system attribute`) on macOS — never interpolated into a shell/AppleScript string, so a
 * diff or instruction full of metacharacters can't break (or inject into) the command.
 */

import { spawn } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const MAC_TITLE = 'Just Call Me — away task finished';

/** Open a persistent on-screen summary. Never throws. */
export function openSummaryWindow(text) {
  if (process.platform === 'darwin') return openMacDialog(text);
  if (process.platform !== 'win32') return;
  try {
    const stamp = Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
    const txtPath = join(tmpdir(), `justcallme-done-${stamp}.txt`);
    const cmdPath = join(tmpdir(), `justcallme-done-${stamp}.cmd`);

    // CRLF so Notepad-family tooling and `type` render the line breaks correctly.
    writeFileSync(txtPath, String(text).replace(/\r?\n/g, '\r\n'), 'utf8');

    // chcp 65001 → UTF-8 so accents / box characters in a summary don't turn to mojibake.
    // /k (via the launcher below) keeps the window open after `type` finishes.
    writeFileSync(
      cmdPath,
      [
        '@echo off',
        'chcp 65001 >nul',
        'title Just Call Me - away task finished',
        `type "${txtPath}"`,
        'echo.',
        'echo (This window is safe to close.)',
        '',
      ].join('\r\n'),
      'utf8',
    );

    // `start` opens a genuinely new, visible console window even though the listener
    // daemon that calls this is itself detached and hidden. `cmd /k` runs our batch and
    // then stays at a prompt, so the window persists until the user closes it.
    const child = spawn('cmd', ['/c', 'start', '', 'cmd', '/k', cmdPath], {
      detached: true,
      stdio: 'ignore',
      windowsHide: false,
    });
    child.on('error', () => {});
    child.unref();
  } catch {
    /* best-effort — a missing console must never disturb the listener */
  }
}

/**
 * macOS: a dialog that stays until dismissed.
 *
 * `display dialog` (not `display notification`) is deliberate — a notification fades after
 * a few seconds, but the whole point is that it's STILL THERE when you walk back to the
 * Mac. A dialog waits for a click, so it persists exactly like the Windows window. Run
 * detached so it never blocks the listener; the text comes from the environment via
 * `system attribute`, so quotes/newlines in a summary can't break or inject into the
 * AppleScript. osascript presents the dialog itself, so there's no System Events
 * automation permission prompt to click through — the setup stays zero-config.
 */
function openMacDialog(text) {
  try {
    const env = { ...process.env, JCM_SUMMARY_TITLE: MAC_TITLE, JCM_SUMMARY_TEXT: String(text) };
    const child = spawn(
      'osascript',
      [
        '-e',
        'display dialog (system attribute "JCM_SUMMARY_TEXT") ' +
          'with title (system attribute "JCM_SUMMARY_TITLE") ' +
          'buttons {"OK"} default button "OK" with icon note',
      ],
      { detached: true, stdio: 'ignore', env },
    );
    child.on('error', () => {});
    child.unref();
  } catch {
    /* best-effort — a missing osascript must never disturb the listener */
  }
}
