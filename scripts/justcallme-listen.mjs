#!/usr/bin/env node
/**
 * JustCallMe — the listener. This is what closes the loop.
 *
 * Run it on the machine where your code lives and leave it running:
 *
 *     node hooks/justcallme-listen.mjs
 *
 * It polls the API for instructions you gave on a call, and runs each one with
 * `claude -p` in the directory the original task came from. That run finishes, its
 * Stop hook fires, and your phone rings again with the result.
 *
 *     you, driving:  "ok, fix the retry logic and call me back"
 *          ↓
 *     listener claims the reply, spawns claude in ~/code/payments
 *          ↓
 *     claude works, finishes, Stop hook fires
 *          ↓
 *     📞  "I fixed the retry logic. 214 tests still pass."
 *
 * ---------------------------------------------------------------------------
 * Read this before you run it
 * ---------------------------------------------------------------------------
 * This executes instructions *you spoke out loud, into a car, to a speech
 * recogniser* as commands on your computer, with no human at the keyboard. That
 * is the entire point, and it is also genuinely risky. Three guards:
 *
 *   1. It only runs in directories the original task came from. Set
 *      JUSTCALLME_ALLOWED_DIRS to constrain it further, and do.
 *   2. It refuses to go more than JUSTCALLME_MAX_CHAIN calls deep, so a task that
 *      re-triggers itself can't phone you all night.
 *   3. It runs one instruction at a time. Two Claudes in one repo is a bad day.
 *
 * It does NOT pass --permission-mode by default, which means Claude Code will
 * prompt for permission and — with nobody at the keyboard — simply block. That's
 * the safe default. To actually get autonomous runs you'll want:
 *
 *     JUSTCALLME_CLAUDE_ARGS="--permission-mode acceptEdits"
 *
 * You can set `bypassPermissions` instead. I'd think hard about that: it means a
 * misheard sentence can run any command on your machine, unattended, while you're
 * on the motorway.
 */

import { spawn } from 'node:child_process';
import { mkdirSync, unlinkSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, join, resolve } from 'node:path';
import { checkChainDepth, checkCwd, parseAllowedDirs } from './lib/guards.mjs';
import { resolveClaudeBin } from './lib/claude-bin.mjs';
import { resolveCodexBin } from './lib/codex-bin.mjs';
import { loadConfig } from './lib/config.mjs';
import { resolveCreds } from './lib/creds.mjs';
import { HEARTBEAT_FILE, PID_FILE } from './lib/daemon.mjs';
import { releaseSystemAwake, syncKeepAwake } from './lib/keepawake.mjs';
import { notifyDesktop } from './lib/notify-desktop.mjs';
import { openSummaryWindow } from './lib/summary-window.mjs';
import { commitWork, createWorktree, isGitRepo, removeWorktree } from './lib/worktree.mjs';

/** Where finished work is left for you to review when you sit back down. */
const INBOX = join(homedir(), '.justcallme', 'inbox');

// Env wins; ~/.justcallme/config.json (written by `/callme pair` and
// `/callme away on`) is the fallback for everything, so the managed daemon
// needs no environment at all.
const fileConfig = loadConfig();
const { apiUrl: API_URL, apiKey: API_KEY } = resolveCreds();
const POLL_SECONDS = Number(process.env.JUSTCALLME_POLL_SECONDS ?? 5);
const MAX_CHAIN = Number(process.env.JUSTCALLME_MAX_CHAIN ?? 5);
// On Windows the CLI lives inside the desktop app under a versioned folder and is
// not on PATH, so we discover the newest install rather than trusting a bare name.
const { bin: CLAUDE_BIN, useShell: CLAUDE_USE_SHELL, source: CLAUDE_SOURCE } = resolveClaudeBin();
// The Codex CLI, for away-instructions that came from Codex (task_meta.agent === 'codex').
// Resolved lazily-cheap here; unused if you never drive Codex.
const { bin: CODEX_BIN, useShell: CODEX_USE_SHELL } = resolveCodexBin();
// How much Claude may do on an unattended run. Order: env override → config.claudeArgs
// → a SAFE default of edits-only. That default matters: unattended execution is gated by
// the app's execution toggle (execution_mode=auto), not by any local command, so when an
// auto instruction arrives we must be able to make progress without a human at the
// keyboard — but only file edits, inside a throwaway worktree. Shell commands still
// prompt (and so block, safely). Set config.claudeArgs / JUSTCALLME_CLAUDE_ARGS to
// '--permission-mode bypassPermissions' to allow commands too (powerful and dangerous).
const SAFE_CLAUDE_ARGS = '--permission-mode acceptEdits';
const EXTRA_ARGS = (
  process.env.JUSTCALLME_CLAUDE_ARGS ??
  fileConfig.claudeArgs ??
  SAFE_CLAUDE_ARGS
).trim();
const DRY_RUN = process.argv.includes('--dry-run');
// Hold the machine awake while we're serving a project, so a sleeping laptop can't
// swallow a call. On by default; JUSTCALLME_KEEP_AWAKE=0 (or "keepAwake": false in
// config.json) opts out for a machine that must be allowed to sleep. See lib/keepawake.mjs.
const KEEP_AWAKE = (() => {
  const env = process.env.JUSTCALLME_KEEP_AWAKE;
  if (env != null) return !/^(0|false|off|no)$/i.test(env.trim());
  return fileConfig.keepAwake !== false;
})();

/** Hard allowlist of directories the listener may run in. `/callme away on` adds a
 *  project's directory; env overrides outright. See lib/guards.mjs.
 *
 *  Re-read on EVERY poll rather than once at startup. A daemon that cached the list at
 *  boot would keep refusing a project you just opted in (the exact bug that dropped a
 *  callback on the floor), and — worse — would keep RUNNING in a project you just opted
 *  OUT of. Reading the small config file every few seconds is free; a stale allowlist
 *  is not. Env still pins it when set. */
function currentAllowedDirs() {
  if (process.env.JUSTCALLME_ALLOWED_DIRS) {
    return parseAllowedDirs(process.env.JUSTCALLME_ALLOWED_DIRS);
  }
  const cfg = loadConfig();
  return Array.isArray(cfg.awayDirs) ? cfg.awayDirs.map((d) => resolve(d)) : [];
}

if (!API_URL || !API_KEY) {
  console.error('No API credentials. Set JUSTCALLME_API_URL / JUSTCALLME_API_KEY, or pair');
  console.error('this machine with:  node hooks/justcallme.mjs pair');
  process.exit(1);
}

// The pidfile is how `/callme away status` (and stop) find us. Best-effort
// cleanup on the way out; a stale file is healed by the next liveness probe.
try {
  writeFileSync(PID_FILE, String(process.pid));
} catch {
  /* a read-only home dir shouldn't stop the listener */
}

/** The liveness beacon daemon.mjs (and the watchdog through it) judge us by. Rewritten at
 *  startup and every poll, so a recycled PID can never make a dead daemon look alive. */
const touchHeartbeat = () => {
  try {
    writeFileSync(HEARTBEAT_FILE, String(Date.now()));
  } catch {
    /* best-effort — a missed beat just risks one spurious restart, never a crash */
  }
};
touchHeartbeat();
const removePid = () => {
  try {
    unlinkSync(PID_FILE);
  } catch {
    /* already gone */
  }
  // Remove the heartbeat on a CLEAN exit so liveness is accurate immediately — otherwise
  // a just-stopped listener would look alive for up to HEARTBEAT_STALE_MS. A crash skips
  // this handler, which is exactly right: the beat simply goes stale and the watchdog
  // notices and restarts.
  try {
    unlinkSync(HEARTBEAT_FILE);
  } catch {
    /* already gone */
  }
  // Drop the wake lock on a clean exit right away. (The helper is bound to our pid and
  // would self-release anyway, so this is belt-and-suspenders — but a crash relies on
  // that binding, so the binding is the real guarantee, not this line.)
  releaseSystemAwake();
};
process.on('exit', removePid);

const ts = () => new Date().toLocaleTimeString();
const log = (...args) => console.log(`[${ts()}]`, ...args);

// ---------------------------------------------------------------------------

async function apiGet(path) {
  const res = await fetch(`${API_URL}${path}`, {
    headers: { authorization: `Bearer ${API_KEY}` },
    signal: AbortSignal.timeout(15_000),
  });
  if (!res.ok) throw new Error(`GET ${path} → ${res.status} ${await res.text()}`);
  return res.json();
}

async function apiPost(path) {
  const res = await fetch(`${API_URL}${path}`, {
    method: 'POST',
    headers: { authorization: `Bearer ${API_KEY}` },
    signal: AbortSignal.timeout(15_000),
  });
  // 409 = another listener claimed it first. Not an error; just not ours.
  if (res.status === 409) return null;
  if (!res.ok) throw new Error(`POST ${path} → ${res.status} ${await res.text()}`);
  return res.json();
}

/** POST a JSON body. Used for the project heartbeat and run status — all fire-and-forget
 *  telemetry that must NEVER disturb the run, so callers .catch() it. Returns null on the
 *  204s these endpoints send. */
async function apiPostJson(path, body) {
  const res = await fetch(`${API_URL}${path}`, {
    method: 'POST',
    headers: { authorization: `Bearer ${API_KEY}`, 'content-type': 'application/json' },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(15_000),
  });
  if (!res.ok) throw new Error(`POST ${path} → ${res.status}`);
  return res.status === 204 ? null : res.json().catch(() => null);
}

/** GET that returns null on 404 instead of throwing — used by the dry-run preview,
 *  where "it's already gone" is a skip, not a crash. */
async function apiGetOrNull(path) {
  const res = await fetch(`${API_URL}${path}`, {
    headers: { authorization: `Bearer ${API_KEY}` },
    signal: AbortSignal.timeout(15_000),
  });
  if (res.status === 404) return null;
  if (!res.ok) throw new Error(`GET ${path} → ${res.status} ${await res.text()}`);
  return res.json();
}

// ---------------------------------------------------------------------------

/** The most of Claude's final answer we keep for the review handoff. `claude -p`
 *  prints the final message to stdout; on a question or a blocked command that text
 *  is the ONLY result there is, so it has to reach you — but it also mustn't bloat the
 *  inbox file, so we keep the tail (where the conclusion lands). */
const MAX_OUTPUT_CHARS = 8000;

/** True when the configured permission level is full-auto (shell commands unattended),
 *  however the user's chosen agent spells it. Both agents share the ONE permission knob
 *  (EXTRA_ARGS / config.claudeArgs): Claude's `bypassPermissions` and Codex's
 *  `danger-full-access` are the same intent, so a single flag drives both. */
const FULL_AUTO = /bypassPermissions|danger-full-access|full-auto|yolo/i.test(EXTRA_ARGS);

/** Build the argv + binary for an agent. Claude: `claude -p <instr> <perm-flags>`.
 *  Codex: `codex exec --ask-for-approval never --sandbox <level> <instr>`, where the
 *  sandbox level is the Codex spelling of the same safe/full-auto choice. */
function agentCommand(agent, instruction) {
  if (agent === 'codex') {
    const sandbox = FULL_AUTO ? 'danger-full-access' : 'workspace-write';
    return {
      bin: CODEX_BIN,
      useShell: CODEX_USE_SHELL,
      // -a never: don't block on approvals unattended. -s: the sandbox = the permission
      // level. The prompt is a positional arg (no shell → no escaping foot-gun).
      args: ['exec', '--ask-for-approval', 'never', '--sandbox', sandbox, instruction],
      envBin: 'JUSTCALLME_CODEX_BIN',
    };
  }
  return {
    bin: CLAUDE_BIN,
    useShell: CLAUDE_USE_SHELL,
    args: ['-p', instruction, ...(EXTRA_ARGS ? EXTRA_ARGS.split(/\s+/) : [])],
    envBin: 'JUSTCALLME_CLAUDE_BIN',
  };
}

/** Spawn the chosen agent in a directory and wait. Resolves `{ code, output }`, where
 *  `output` is the agent's captured stdout (its final answer). Both `claude -p` and
 *  `codex exec` print their final message to stdout, which for a question or a blocked
 *  command is the ONLY result there is — so it has to reach the review handoff.
 *
 *  `callbackWhenDone` is the choice the user made on the call ("ring me when it's
 *  done?"). Only an explicit `false` suppresses the callback — undefined/null keeps the
 *  default of ringing back (see justcallme-stop-hook.mjs / justcallme-codex-notify.mjs). */
function runAgent({ agent, instruction, dir, project, chainDepth, callbackWhenDone }) {
  return new Promise((done) => {
    const { bin, useShell, args, envBin } = agentCommand(agent, instruction);

    const child = spawn(bin, args, {
      cwd: dir,
      env: {
        ...process.env,
        // The user declined a callback on the call — tell the spawned run's completion
        // hook (Stop hook / Codex notify) not to ring. Absent = ring when done.
        ...(callbackWhenDone === false ? { JUSTCALLME_SUPPRESS_CALLBACK: '1' } : {}),
        // The spawned run's own completion hook reads this and reports it back on /notify,
        // which is how the chain gets counted at all. (Codex inherits this env and passes
        // it through to the notify program, so the chain closes for Codex too.)
        JUSTCALLME_CHAIN_DEPTH: String(chainDepth + 1),
        // The hook derives the project from the cwd — which is now a worktree with a
        // slug for a name, not your repo. Without this it would look like an unknown
        // project and never call you back, which is precisely the call you're waiting for.
        JUSTCALLME_PROJECT: project,
        // A follow-up you explicitly asked for is worth a call however quick it was.
        JUSTCALLME_MIN_SECONDS: '0',
      },
      // stdout is PIPED (not inherited) so we can keep the agent's final answer for the
      // review handoff. We still echo every chunk to our own stdout, so the daemon log
      // keeps the full record. stderr stays inherited.
      stdio: ['ignore', 'pipe', 'inherit'],
      // A concrete .exe path spawns directly (no shell → no arg-escaping foot-gun); only a
      // bare-name fallback needs a shell to resolve a .cmd shim.
      shell: useShell,
      // No flickering console: the daemon is hidden, and the persistent summary window
      // (opened when the run finishes) is the deliberate, readable replacement.
      windowsHide: true,
    });

    let output = '';
    child.stdout?.on('data', (chunk) => {
      process.stdout.write(chunk); // preserve the listener.log record
      output += chunk.toString();
      if (output.length > MAX_OUTPUT_CHARS) output = output.slice(-MAX_OUTPUT_CHARS);
    });

    child.on('error', (err) => {
      console.error(`  ✗ could not start ${bin}: ${err.message}`);
      console.error(`    Set ${envBin} to the full path of your ${agent} executable.`);
      done({ code: 1, output: '' });
    });
    child.on('exit', (code) => done({ code: code ?? 1, output: output.trim() }));
  });
}

/**
 * Run one confirmed instruction — in an isolated worktree, on its own branch.
 *
 * Your actual checkout is never touched. You can be mid-edit, with uncommitted
 * changes, on a different branch, and this cannot hurt you. The work lands as a
 * branch and a commit; it is NEVER merged and NEVER pushed.
 *
 * That isolation is what makes running unattended defensible at all. It's the same
 * conclusion Cursor, Jules, Devin, Copilot and Codex all reached: the human review of
 * a diff is what replaces the confirmation you cannot ask for while they're driving.
 */
async function runInstruction({ instruction, cwd, project, chainDepth, callId, callbackWhenDone, agent }) {
  if (!isGitRepo(cwd)) {
    log(`⛔ ${cwd} is not a git repository — refusing to run.`);
    log('   Unattended work only happens on a branch. There is nowhere safe to put it.');
    return;
  }

  if (DRY_RUN) {
    const { bin, args } = agentCommand(agent, '<instruction>');
    log(`▶ [dry run] would branch from ${cwd} and run (${agent}):`);
    log(`  "${instruction}"`);
    log(`  ${bin} ${args.join(' ')}`);
    return;
  }

  let tree;
  try {
    tree = createWorktree({ repoCwd: cwd, instruction, callId });
  } catch (err) {
    log(`⛔ could not create a worktree: ${err.message}`);
    return;
  }

  log(`▶ ${tree.branch}`);
  log(`  "${instruction}"`);

  // Mark it running so the app can show "Running — started just now" for this project.
  apiPostJson('/internal/runs/start', { call_session_id: callId, project, instruction }).catch(
    () => {},
  );

  const { code, output } = await runAgent({
    agent,
    instruction,
    dir: tree.dir,
    project,
    chainDepth,
    callbackWhenDone,
  });

  let result = { changed: false, stat: '', sha: null };
  try {
    result = commitWork({ dir: tree.dir, instruction, callId });
  } catch (err) {
    log(`  ⚠ could not commit the work: ${err.message}`);
  }

  // The worktree goes; the BRANCH stays. The branch is the deliverable.
  removeWorktree({ repoCwd: cwd, dir: tree.dir });

  if (result.changed) {
    log(`  ✓ ${tree.branch} — ${result.stat}`);
  } else {
    log(`  ✓ done, but nothing changed (exit ${code})`);
  }

  // Close out the run for the app's status: done (changed), empty (clean exit, no
  // change), or failed (non-zero exit with nothing to show). Best-effort.
  const runStatus = result.changed ? 'done' : code === 0 ? 'empty' : 'failed';
  apiPostJson('/internal/runs/finish', {
    call_session_id: callId,
    status: runStatus,
    branch: tree.branch,
    changed: result.changed,
    summary: output || null,
  }).catch(() => {});

  // One timestamp, shared by the inbox record and the summary window, so they never
  // disagree about when this finished.
  const finishedAt = new Date();

  // Pop a desktop toast the moment the branch lands. The SessionStart handoff only
  // surfaces this when you next OPEN Claude Code here; the toast reaches you even if
  // you're at the PC doing something else. Best-effort — never blocks the run.
  notifyDesktop(
    result.changed ? 'Just Call Me — branch ready to review' : 'Just Call Me — away task finished',
    result.changed
      ? `${tree.branch}\n${result.stat}`
      : `${tree.branch}\nRan but changed nothing (exit ${code})`,
  );

  // …and a persistent window that stays open with the whole story. You asked for a
  // callback, so you're owed a reply you can actually sit and read — every run gets
  // one, whether or not it changed anything.
  const summaryLines = [
    'Just Call Me — away task finished',
    finishedAt.toLocaleString(),
    '',
    'You asked, on a call:',
    `  "${instruction}"`,
    '',
  ];
  if (result.changed) {
    summaryLines.push(
      'Task done:',
      output || '(Claude left no summary text.)',
      '',
      `Committed to ${tree.branch}`,
      `  ${result.stat}`,
      '',
      `Review:  git diff ${tree.baseRef?.slice(0, 8)}..${tree.branch}`,
    );
  } else {
    summaryLines.push(
      `It ran but changed nothing (exit code ${code}).`,
      `Branch ${tree.branch} exists but is empty.`,
      ...(output ? ['', 'What it said:', output] : []),
    );
  }
  openSummaryWindow(summaryLines.join('\n'));

  // Leave it in the inbox, so that when you next open Claude Code in this project it
  // can tell you what happened while you were out. See justcallme-session-start.mjs.
  try {
    mkdirSync(INBOX, { recursive: true });
    writeFileSync(
      join(INBOX, `${callId}.json`),
      JSON.stringify(
        {
          callId,
          project,
          repo: cwd,
          instruction,
          branch: tree.branch,
          baseRef: tree.baseRef,
          changed: result.changed,
          stat: result.stat,
          sha: result.sha,
          exitCode: code,
          // Claude's final answer. On a question or a command it couldn't run, this is
          // the only result — the SessionStart hook surfaces it so it reaches you.
          output: output || null,
          finishedAt: finishedAt.toISOString(),
        },
        null,
        2,
      ),
    );
  } catch (err) {
    log(`  ⚠ could not write to the inbox: ${err.message}`);
  }
}

// ---------------------------------------------------------------------------

let running = false;

/** In dry-run nothing is consumed, so the same pending reply resurfaces on every
 *  poll. Remember what we've already shown so a dry run prints each instruction
 *  once, not once every POLL_SECONDS forever. */
const previewed = new Set();

/** Instruction ids we've refused and already warned about. A refused reply is left in
 *  the queue (not claimed), so without this it would re-toast every single poll. Cleared
 *  when it finally runs, so if you fix the cause it warns you again only if it re-breaks. */
const refusedNotified = new Set();

async function tick() {
  touchHeartbeat(); // proof-of-life on every poll — BEFORE the running-guard, so a long
                    // unattended run (when tick returns early) still keeps the beat fresh
                    // and the watchdog doesn't mistake a busy listener for a dead one.
  if (running) return; // still working on the last one
  running = true;

  try {
    // The allowlist, fresh every poll (see currentAllowedDirs) — so opting a project
    // in or out takes effect immediately, without restarting the daemon.
    const allowedDirs = currentAllowedDirs();

    // Hold the machine awake exactly while we're actually serving something. Armed
    // (a dir is opted in) → keep it awake so polling and inbound calls survive an
    // idle timer. Nothing armed → let it sleep like any other idle machine. Re-run
    // every poll so it tracks arming without a restart. Never in dry-run.
    if (KEEP_AWAKE) syncKeepAwake(!DRY_RUN && allowedDirs.length > 0);

    // Heartbeat the projects we serve, so the app can list them ("Call a project") with
    // a live "synced Xm ago". Fire-and-forget; a failed heartbeat must never delay a poll.
    if (!DRY_RUN && allowedDirs.length) {
      apiPostJson('/projects/heartbeat', {
        projects: allowedDirs.map((dir) => ({ name: basename(dir), dir })),
      }).catch(() => {});
    }

    // mode=auto: ONLY instructions the user gave under away mode. Ask-mode
    // instructions wait for the SessionStart hook — this daemon must never
    // run something the user expected to review first. The poll doubles as
    // the heartbeat the app shows as "helper online".
    const { pending } = await apiGet('/calls/pending-replies?mode=auto');

    for (const item of pending) {
      // PREVIEW first — a read that does NOT consume the one-shot reply. We decide
      // whether we may run it BEFORE claiming. This is the safety fix: the guards
      // (allowlist, git repo, chain depth) all need task_meta.cwd, which only the reply
      // carries — so the old code claimed (consumed) and THEN checked, and a refused
      // instruction was burned. Now a refusal leaves it in the queue, ready to run the
      // moment you fix the cause.
      const preview = await apiGetOrNull(`/calls/${item.id}/reply/preview`);
      if (!preview) continue; // already consumed, or gone

      const { instruction, task_meta, chain_depth } = preview;
      const cwd = task_meta?.cwd;

      // First reason wins. checkCwd verifies the dir exists before we probe it for git.
      const reason =
        checkCwd(cwd, allowedDirs) ||
        (!isGitRepo(cwd)
          ? `${cwd} is not a git repository — unattended work only runs on a branch`
          : null) ||
        checkChainDepth(chain_depth, MAX_CHAIN);

      if (reason) {
        // Tell you ONCE. A silent refusal after you asked for a call-back is the whole
        // bug we're closing. We do NOT claim, so it stays in the queue: fix the cause —
        // e.g. `/callme away on` in that project — and the next poll picks it up.
        if (!refusedNotified.has(item.id)) {
          refusedNotified.add(item.id);
          log(`⛔ NOT running "${instruction.slice(0, 60)}…": ${reason}`);
          notifyDesktop(
            'Just Call Me — instruction NOT run',
            `"${instruction.slice(0, 100)}"\n${reason}\n` +
              `It's still queued — fix it (e.g. /callme away on in that project) and it'll run.`,
          );
        }
        continue;
      }

      // Cleared to run. In dry-run we only ANNOUNCE (never claim, never execute), once.
      if (DRY_RUN) {
        if (previewed.has(item.id)) continue;
        previewed.add(item.id);
        await runInstruction({
          instruction,
          cwd,
          project: task_meta?.project ?? 'unknown',
          chainDepth: chain_depth,
          callId: item.id,
          callbackWhenDone: task_meta?.callback_when_done,
          agent: task_meta?.agent === 'codex' ? 'codex' : 'claude',
        });
        continue;
      }

      // Real path: CLAIM (atomic, one-shot) now that we know we can honour it. If a
      // stale sibling listener claimed it between our preview and now, claim returns
      // null (409) and we simply move on.
      const claimed = await apiPost(`/calls/${item.id}/reply/claim`);
      if (!claimed) continue;
      refusedNotified.delete(item.id); // it ran — no longer stuck

      await runInstruction({
        instruction: claimed.instruction,
        cwd: claimed.task_meta?.cwd,
        project: claimed.task_meta?.project ?? 'unknown',
        chainDepth: claimed.chain_depth,
        callId: item.id,
        // The user's "call me when it's done?" answer, stashed in task_meta by the API.
        // Only an explicit false suppresses the callback.
        callbackWhenDone: claimed.task_meta?.callback_when_done,
        // Which CLI to run it with — Codex instructions carry agent:'codex' in task_meta
        // (set by justcallme-codex-notify.mjs). Everything else defaults to Claude.
        agent: claimed.task_meta?.agent === 'codex' ? 'codex' : 'claude',
      });
    }
  } catch (err) {
    // The network being down, or Render cold-starting, is not fatal. Keep polling.
    log(`… ${err.message}`);
  } finally {
    running = false;
  }
}

// ---------------------------------------------------------------------------

log(`justcallme listener up — polling ${API_URL} every ${POLL_SECONDS}s`);
log(`claude: ${CLAUDE_BIN}  [${CLAUDE_SOURCE}]`);
if (DRY_RUN) log('DRY RUN: instructions will be printed, not executed.');
const startupDirs = currentAllowedDirs();
if (startupDirs.length) log(`restricted to: ${startupDirs.join(', ')}  (re-read every poll)`);
else log('⚠ no allowed dirs set — will run in whatever cwd the task came from.');
log(
  KEEP_AWAKE
    ? 'keep-awake: on while a project is served (JUSTCALLME_KEEP_AWAKE=0 to disable)'
    : 'keep-awake: off — this machine may sleep and miss calls',
);
log(
  /bypassPermissions/.test(EXTRA_ARGS)
    ? '⚠ permission: FULL AUTO — Claude runs shell commands unattended (set config.claudeArgs to change)'
    : `permission: ${EXTRA_ARGS} (edits-only; shell commands still prompt)`,
);

void tick();
setInterval(() => void tick(), POLL_SECONDS * 1000);

process.on('SIGINT', () => {
  log('bye');
  process.exit(0);
});
