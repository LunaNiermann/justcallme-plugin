/**
 * Pop a console window that STAYS OPEN with a summary of an away-mode run.
 *
 * The toast (see notify-desktop.mjs) is a glance; this is the "sit down and read it"
 * companion. When the listener finishes a call instruction it opens one of these
 * showing what Claude did and where it landed, and leaves it open until you close it —
 * so a branch built while you were away doesn't just flash past and vanish.
 *
 * Windows only: a persistent console window is a Windows-desktop idea. On macOS/Linux
 * this is a no-op (the toast still fires); a terminal-window equivalent there would be
 * a different mechanism and isn't wired yet.
 *
 * The summary text is written to a temp file and shown with `type`, NOT echoed line by
 * line — an instruction or a diff can contain any of cmd's metacharacters (& | < > "),
 * and `type` on a raw file sidesteps all of that escaping entirely.
 */

import { spawn } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/** Open a persistent summary window. Never throws. */
export function openSummaryWindow(text) {
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
