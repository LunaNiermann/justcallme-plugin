#!/usr/bin/env node
/**
 * JustCallMe — Claude Code `SessionStart` hook. The review handoff.
 *
 * When you open Claude Code in a project, this tells the session what happened while
 * you were away:
 *
 *   - work the listener already did (branch, diff stat, the instruction you confirmed)
 *   - instructions you confirmed on a call that nobody has run yet
 *
 * ---------------------------------------------------------------------------
 * Why this exists, and what it is NOT
 * ---------------------------------------------------------------------------
 * A voice call is an excellent channel for APPROVING an instruction — it's synchronous
 * and you're guaranteed to be paying attention. It is a terrible channel for REVIEWING
 * code: you cannot read a diff over the phone while driving.
 *
 * So the two are split. The call approves the intent. The diff waits for you here.
 *
 * This is deliberately not a substitute for the listener. `SessionStart` fires when a
 * session STARTS — an idle open session never fires it, and there is no API to inject a
 * turn into a live one. So this is "it'll be waiting when you sit down", not "it
 * happens while you're away". Only the listener does the latter.
 *
 * Exits 0 on every path. A hook that breaks your session is a worse bug than the one
 * it was reporting.
 */

import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, join } from 'node:path';
import { resolveCreds } from './lib/creds.mjs';
import { loadConfig, saveConfig } from './lib/config.mjs';
import { ensureRunning } from './lib/daemon.mjs';
import { notifyDesktop } from './lib/notify-desktop.mjs';
import { openSummaryWindow } from './lib/summary-window.mjs';

const HOME = join(homedir(), '.justcallme');
const INBOX = join(HOME, 'inbox');
const SEEN = join(HOME, 'inbox', 'seen');
const NOTICES = join(HOME, 'notices');
const NOTICES_SEEN = join(HOME, 'notices', 'seen');

// Env wins; ~/.justcallme/config.json (written by `/callme pair`) is the fallback.
const { apiUrl: API_URL, apiKey: API_KEY } = resolveCreds();

/** Emit context into the session, in the shape Claude Code expects.
 *
 * Note: NO process.exit() here. Forcing an exit while fetch's keep-alive socket is
 * still open crashes Node on Windows with a libuv assertion
 * ("!(handle->flags & UV_HANDLE_CLOSING)"). We let the event loop drain on its own —
 * there's nothing keeping it alive once the requests settle. */
function emit(context) {
  if (context) {
    process.stdout.write(
      JSON.stringify({
        hookSpecificOutput: {
          hookEventName: 'SessionStart',
          additionalContext: context,
        },
      }),
    );
  }
}

let payload = {};
try {
  const raw = readFileSync(0, 'utf8');
  payload = raw.trim() ? JSON.parse(raw) : {};
} catch {
  // no stdin, nothing to do — fall through and let the process end naturally
}

const cwd = payload.cwd ?? process.cwd();
const project = basename(cwd);
const parts = [];

// --- 0. the helper "just works" --------------------------------------------
// No /callme away, no setup command: every session we make sure the background helper
// is running (reviving a dead one) and register THIS project so the helper serves it —
// the app can then list it under "Call a project", and an away instruction for it can
// run. Registering only touches the allowlist; whether anything actually RUNS unattended
// is still gated by the account's execution_mode (default: wait for you). All
// best-effort — a session must start whether or not any of this succeeds.
try {
  const cfg = loadConfig();
  // `/callme away off` is the one opt-out: honour it and don't resurrect the helper.
  if (!cfg.helperDisabled) {
    const dirs = new Set(Array.isArray(cfg.awayDirs) ? cfg.awayDirs : []);
    if (cwd && !dirs.has(cwd)) {
      dirs.add(cwd);
      cfg.awayDirs = [...dirs];
      saveConfig(cfg);
    }
    ensureRunning();
  }
} catch {
  /* the helper is a background nicety; never delay or break a session over it */
}

// --- 1. work the listener already did --------------------------------------
try {
  if (existsSync(INBOX)) {
    mkdirSync(SEEN, { recursive: true });

    const items = readdirSync(INBOX)
      .filter((f) => f.endsWith('.json'))
      .map((f) => {
        try {
          return { file: f, ...JSON.parse(readFileSync(join(INBOX, f), 'utf8')) };
        } catch {
          return null;
        }
      })
      .filter((x) => x && x.project === project);

    for (const item of items) {
      const lines = [
        `While you were away, you asked for this on a call and confirmed it out loud:`,
        ``,
        `  "${item.instruction}"`,
        ``,
        item.changed
          ? [
              `It ran unattended and the work is on a branch — NOT merged, NOT pushed, and`,
              `your working tree was never touched.`,
              ``,
              `  branch : ${item.branch}`,
              `  base   : ${item.baseRef?.slice(0, 8)}`,
              `  diff   : ${item.stat}`,
              ``,
              `Review it before trusting it. It was written from a voice instruction with`,
              `nobody watching:`,
              ``,
              `  git diff ${item.baseRef?.slice(0, 8)}..${item.branch}`,
            ].join('\n')
          : [
              `It ran but changed nothing (exit code ${item.exitCode}).`,
              `Branch ${item.branch} exists but is empty.`,
            ].join('\n'),
      ];

      // What Claude actually said. For a code change this is its own summary; for a
      // question or a blocked command it IS the deliverable — the only place the answer
      // lives, so it has to be surfaced here or it's lost in a daemon log.
      if (item.output) {
        lines.push(
          ``,
          item.changed
            ? `What it reported when it finished:`
            : `It changed no files, but here is what it said — this may be the answer you` +
                ` asked for, or the reason nothing changed (e.g. a command it wasn't` +
                ` allowed to run unattended):`,
          ``,
          item.output
            .split('\n')
            .map((l) => `  ${l}`)
            .join('\n'),
        );
      }

      parts.push(lines.join('\n'));

      // Move it out of the inbox so it's reported exactly once.
      try {
        renameSync(join(INBOX, item.file), join(SEEN, item.file));
      } catch {
        /* best effort */
      }
    }
  }
} catch {
  /* the inbox is a nicety; never break the session over it */
}

// --- 2. confirmed instructions nobody has run ------------------------------
// If the listener isn't running, they're just sitting in the queue. You're here now,
// so you're the one who can act on them — claim them and hand them over.
try {
  if (API_URL && API_KEY) {
    // mode=ask: only instructions waiting for the user. Away-mode work belongs
    // to the listener daemon and must not be double-claimed here.
    const res = await fetch(`${API_URL}/calls/pending-replies?mode=ask`, {
      headers: { authorization: `Bearer ${API_KEY}` },
      signal: AbortSignal.timeout(6000),
    });

    if (res.ok) {
      const { pending } = await res.json();

      for (const item of pending.slice(0, 5)) {
        const claim = await fetch(`${API_URL}/calls/${item.id}/reply/claim`, {
          method: 'POST',
          headers: { authorization: `Bearer ${API_KEY}` },
          signal: AbortSignal.timeout(6000),
        });
        if (!claim.ok) continue; // 409: the listener beat us to it. Good.

        const { instruction, task_meta } = await claim.json();
        if (task_meta?.project && task_meta.project !== project) continue;

        parts.push(
          [
            `You confirmed this instruction on a call, and nothing has run it yet:`,
            ``,
            `  "${instruction}"`,
            ``,
            `Ask the user whether they still want it before doing anything.`,
          ].join('\n'),
        );

        // You just sat down and opened Claude Code — the "at my desk" moment the safe-
        // mode reminder is named for. Surface it on the desktop too, exactly like an
        // away-mode result: a toast plus a window that stays open. No daemon and no
        // polling — this rides the session-start hook, so it costs nothing when the
        // queue is empty.
        notifyDesktop(
          'Just Call Me — reminder',
          `${instruction}\nYou asked for this on a call — it's waiting for you.`,
        );
        openSummaryWindow(
          [
            'Just Call Me — reminder',
            new Date().toLocaleString(),
            '',
            'You asked for this on a call, and it has been waiting for you:',
            `  "${instruction}"`,
            '',
            'You are at your desk now — Claude Code will offer to run it in this session.',
          ].join('\n'),
        );
      }
    }
  }
} catch {
  // The API being unreachable must never delay or break a session start.
}

// --- 3. "couldn't ring you — out of minutes" notices -----------------------
// Written by the settle watcher when /notify returns 402. Account-wide, so we surface
// it whatever project you open, and consume it once.
try {
  if (existsSync(NOTICES)) {
    mkdirSync(NOTICES_SEEN, { recursive: true });

    const files = readdirSync(NOTICES).filter((f) => f.endsWith('.json'));
    for (const file of files) {
      let notice;
      try {
        notice = JSON.parse(readFileSync(join(NOTICES, file), 'utf8'));
      } catch {
        continue;
      }

      if (notice?.type === 'out_of_minutes') {
        const resets = notice.period_end
          ? ` (they reset ${new Date(notice.period_end).toLocaleDateString()})`
          : '';
        const included = notice.minutes_included
          ? `${notice.minutes_included} free minutes`
          : 'your free minutes';
        parts.push(
          [
            `Just Call Me couldn't ring you — you've used ${included} for this cycle${resets}.`,
            ``,
            `Tell the user, and mention they can add minutes or move to a paid plan by`,
            `running \`/callme upgrade\`, which prints a personal link to getjustcall.me.`,
          ].join('\n'),
        );
      }

      try {
        renameSync(join(NOTICES, file), join(NOTICES_SEEN, file));
      } catch {
        /* best effort */
      }
    }
  }
} catch {
  /* notices are a nicety; never break the session over one */
}

if (parts.length) {
  emit(
    [
      `## Just Call Me — while you were away`,
      ``,
      parts.join('\n\n---\n\n'),
      ``,
      `(Mention this to the user; they may not know it happened.)`,
    ].join('\n'),
  );
}

// No process.exit(). fetch keeps a keep-alive socket around briefly, and forcing an
// exit over the top of it crashes Node on Windows (libuv UV_HANDLE_CLOSING assertion).
// There's nothing left keeping the loop alive, so it ends on its own, cleanly.
