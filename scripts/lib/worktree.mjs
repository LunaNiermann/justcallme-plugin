/**
 * Run unattended work in an isolated git worktree, never in the user's live checkout.
 *
 * This is the pattern the entire industry converged on, arrived at from six different
 * directions: Cursor, Jules, Devin, Copilot, Codex cloud and Claude Code on the web all
 * run agent work in an isolated environment on its own branch, and the artifact is a
 * REVIEWABLE PROPOSAL — a PR or a diff — never a mutation of your working tree.
 *
 * The reason isn't tidiness. It's that the review gate is what *replaces* real-time
 * confirmation. They can't ask you mid-run, because you're asleep. So the work can be
 * autonomous precisely because nothing lands without a human reading it.
 *
 * Applied here:
 *
 *   - a branch, `justcallme/<slug>`, cut from whatever HEAD you were on
 *   - a git worktree, so your actual checkout is never touched. You can be mid-edit,
 *     with uncommitted changes, on a different branch, and this still cannot hurt you.
 *   - changes are committed on that branch, so the diff survives
 *   - NEVER a merge, NEVER a push, NEVER a force. It waits for you.
 *
 * A worktree rather than a clone because it shares the object store: it's near-instant
 * and costs no disk, even on a large repo.
 */

import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

const WORKTREE_ROOT = join(homedir(), '.justcallme', 'worktrees');

function git(args, cwd) {
  return execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
}

/** Is this a git repo at all? */
export function isGitRepo(cwd) {
  try {
    return git(['rev-parse', '--is-inside-work-tree'], cwd) === 'true';
  } catch {
    return false;
  }
}

/** A short, filesystem-safe slug from the instruction. */
function slugify(instruction, id) {
  const words = instruction
    .toLowerCase()
    .replace(/[^a-z0-9\s-]/g, '')
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 5)
    .join('-');
  return `${words || 'task'}-${id.slice(0, 6)}`;
}

/**
 * Create an isolated worktree on a new branch.
 *
 * @returns {{ branch: string, dir: string, baseRef: string }}
 */
export function createWorktree({ repoCwd, instruction, callId }) {
  const slug = slugify(instruction, callId);
  const branch = `justcallme/${slug}`;
  const dir = join(WORKTREE_ROOT, slug);

  mkdirSync(WORKTREE_ROOT, { recursive: true });

  // Branch from the CURRENT HEAD of the user's checkout — not from main. If they're on
  // a feature branch, the work should build on that, not silently diverge.
  const baseRef = git(['rev-parse', 'HEAD'], repoCwd);

  // `git worktree add` refuses to clobber an existing dir, which is what we want.
  git(['worktree', 'add', '-b', branch, dir, baseRef], repoCwd);

  return { branch, dir, baseRef };
}

/**
 * Commit whatever the agent changed, so the diff is durable and reviewable.
 *
 * Does NOT push and does NOT merge — deliberately. The whole safety model rests on
 * the work waiting for a human to read it.
 *
 * @returns {{ changed: boolean, stat: string, sha: string|null }}
 */
export function commitWork({ dir, instruction, callId }) {
  git(['add', '-A'], dir);

  // Anything actually staged?
  const staged = git(['diff', '--cached', '--name-only'], dir);
  if (!staged) {
    return { changed: false, stat: '', sha: null };
  }

  const stat = git(['diff', '--cached', '--shortstat'], dir);

  const message = [
    instruction.length > 68 ? `${instruction.slice(0, 67)}…` : instruction,
    '',
    'Spoken on a JustCallMe call and confirmed out loud before running.',
    `call: ${callId}`,
    '',
    'This ran unattended. Read the diff before merging anything.',
  ].join('\n');

  git(['-c', 'user.name=JustCallMe', '-c', 'user.email=noreply@justcallme.local', 'commit', '-m', message], dir);

  return { changed: true, stat, sha: git(['rev-parse', 'HEAD'], dir) };
}

/** Tear the worktree down but KEEP the branch — the branch is the deliverable. */
export function removeWorktree({ repoCwd, dir }) {
  try {
    git(['worktree', 'remove', '--force', dir], repoCwd);
  } catch {
    /* leave it; a stale worktree is harmless and `git worktree prune` cleans up */
  }
}

export { WORKTREE_ROOT, existsSync };
