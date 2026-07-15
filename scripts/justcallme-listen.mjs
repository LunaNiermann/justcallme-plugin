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
import { mkdirSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { checkChainDepth, checkCwd, parseAllowedDirs } from './lib/guards.mjs';
import { resolveClaudeBin } from './lib/claude-bin.mjs';
import { resolveCreds } from './lib/creds.mjs';
import { commitWork, createWorktree, isGitRepo, removeWorktree } from './lib/worktree.mjs';

/** Where finished work is left for you to review when you sit back down. */
const INBOX = join(homedir(), '.justcallme', 'inbox');

// Env wins; ~/.justcallme/config.json (written by `/callme pair`) is the fallback.
const { apiUrl: API_URL, apiKey: API_KEY } = resolveCreds();
const POLL_SECONDS = Number(process.env.JUSTCALLME_POLL_SECONDS ?? 5);
const MAX_CHAIN = Number(process.env.JUSTCALLME_MAX_CHAIN ?? 5);
// On Windows the CLI lives inside the desktop app under a versioned folder and is
// not on PATH, so we discover the newest install rather than trusting a bare name.
const { bin: CLAUDE_BIN, useShell: CLAUDE_USE_SHELL, source: CLAUDE_SOURCE } = resolveClaudeBin();
const EXTRA_ARGS = (process.env.JUSTCALLME_CLAUDE_ARGS ?? '').trim();
const DRY_RUN = process.argv.includes('--dry-run');

/** Optional hard allowlist of directories the listener may run in. See lib/guards.mjs. */
const ALLOWED_DIRS = parseAllowedDirs(process.env.JUSTCALLME_ALLOWED_DIRS);

if (!API_URL || !API_KEY) {
  console.error('No API credentials. Set JUSTCALLME_API_URL / JUSTCALLME_API_KEY, or pair');
  console.error('this machine with:  node hooks/justcallme.mjs pair');
  process.exit(1);
}

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

/** Spawn `claude -p` in a directory and wait. */
function runClaude({ instruction, dir, project, chainDepth }) {
  return new Promise((done) => {
    const args = ['-p', instruction, ...(EXTRA_ARGS ? EXTRA_ARGS.split(/\s+/) : [])];

    const child = spawn(CLAUDE_BIN, args, {
      cwd: dir,
      env: {
        ...process.env,
        // The spawned run's own Stop hook reads this and reports it back on /notify,
        // which is how the chain gets counted at all.
        JUSTCALLME_CHAIN_DEPTH: String(chainDepth + 1),
        // The hook derives the project from the cwd — which is now a worktree with a
        // slug for a name, not your repo. Without this it would look like an unknown
        // project and never call you back, which is precisely the call you're waiting
        // for.
        JUSTCALLME_PROJECT: project,
        // A follow-up you explicitly asked for is worth a call however quick it was —
        // you're waiting for it.
        JUSTCALLME_MIN_SECONDS: '0',
      },
      stdio: ['ignore', 'inherit', 'inherit'],
      // A concrete claude.exe path spawns directly (no shell → no arg-escaping
      // foot-gun). Only a bare-name fallback needs a shell to resolve a .cmd shim.
      shell: CLAUDE_USE_SHELL,
    });

    child.on('error', (err) => {
      console.error(`  ✗ could not start ${CLAUDE_BIN}: ${err.message}`);
      console.error('    Set JUSTCALLME_CLAUDE_BIN to the full path of your claude executable.');
      done(1);
    });
    child.on('exit', (code) => done(code ?? 1));
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
async function runInstruction({ instruction, cwd, project, chainDepth, callId }) {
  if (!isGitRepo(cwd)) {
    log(`⛔ ${cwd} is not a git repository — refusing to run.`);
    log('   Unattended work only happens on a branch. There is nowhere safe to put it.');
    return;
  }

  if (DRY_RUN) {
    log(`▶ [dry run] would branch from ${cwd} and run:`);
    log(`  "${instruction}"`);
    log(`  ${CLAUDE_BIN} -p <instruction> ${EXTRA_ARGS}`);
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

  const code = await runClaude({ instruction, dir: tree.dir, project, chainDepth });

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
          finishedAt: new Date().toISOString(),
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

async function tick() {
  if (running) return; // still working on the last one
  running = true;

  try {
    const { pending } = await apiGet('/calls/pending-replies');

    for (const item of pending) {
      // In dry-run, don't re-announce something we've already printed this run.
      if (DRY_RUN && previewed.has(item.id)) continue;

      // A dry run must NEVER consume the instruction. It PREVIEWS (a read that
      // leaves reply_consumed_at untouched) so you can watch what it would do and
      // then run it for real. Claiming here would silently burn the instruction --
      // the reply is one-shot -- which is exactly the bug this avoids.
      // The real path CLAIMS: claim first, run second. If we crashed between reading
      // and running the instruction would be lost, but running a mis-heard sentence
      // twice is far worse than zero times, so at-most-once it is.
      const got = DRY_RUN
        ? await apiGetOrNull(`/calls/${item.id}/reply/preview`)
        : await apiPost(`/calls/${item.id}/reply/claim`);
      if (!got) continue; // somebody else got it (claim 409), or nothing to preview
      if (DRY_RUN) previewed.add(item.id);

      const { instruction, task_meta, chain_depth } = got;
      const cwd = task_meta?.cwd;

      const tooDeep = checkChainDepth(chain_depth, MAX_CHAIN);
      if (tooDeep) {
        log(`⛔ ${tooDeep}. Not running: "${instruction.slice(0, 60)}…"`);
        log('   Raise the ceiling, or run it yourself — this is the runaway guard.');
        continue;
      }

      const problem = checkCwd(cwd, ALLOWED_DIRS);
      if (problem) {
        log(`⛔ refusing to run: ${problem}`);
        log(`   The instruction was: "${instruction}"`);
        continue;
      }

      await runInstruction({
        instruction,
        cwd,
        project: task_meta?.project ?? 'unknown',
        chainDepth: chain_depth,
        callId: item.id,
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
if (ALLOWED_DIRS.length) log(`restricted to: ${ALLOWED_DIRS.join(', ')}`);
else log('⚠ no JUSTCALLME_ALLOWED_DIRS set — will run in whatever cwd the task came from.');
if (!EXTRA_ARGS) {
  log('⚠ no JUSTCALLME_CLAUDE_ARGS — Claude Code will prompt for permission and, with');
  log('  nobody at the keyboard, block. Set --permission-mode acceptEdits for real use.');
}

void tick();
setInterval(() => void tick(), POLL_SECONDS * 1000);

process.on('SIGINT', () => {
  log('bye');
  process.exit(0);
});
