/**
 * The listener's safety guards.
 *
 * Extracted from justcallme-listen.mjs specifically so they can be tested. These
 * decide whether a voice-transcribed instruction gets executed on your machine, so
 * a bug here is both silent and dangerous — and there *was* one: the allowlist
 * used to be split on /[;:]/, which tears "C:/code" apart at the drive letter and
 * made the whole guard fail OPEN. It looked fine in every log.
 *
 * That is the entire argument for this file existing.
 */

import { existsSync } from 'node:fs';
import { delimiter, resolve, sep } from 'node:path';

/**
 * Parse JUSTCALLME_ALLOWED_DIRS.
 *
 * Split on the platform's path delimiter — ';' on Windows, ':' elsewhere, exactly
 * like PATH. Splitting on ':' unconditionally is the bug described above.
 */
export function parseAllowedDirs(raw) {
  return (raw ?? '')
    .split(delimiter)
    .map((d) => d.trim())
    .filter(Boolean)
    .map((d) => resolve(d));
}

/**
 * May we run in this directory?
 *
 * @returns null if allowed, or a human-readable reason if not.
 */
export function checkCwd(cwd, allowedDirs = [], exists = existsSync) {
  if (!cwd) return 'the original task recorded no working directory';
  if (!exists(cwd)) return `${cwd} does not exist on this machine`;

  if (allowedDirs.length > 0) {
    // Both sides go through resolve(), so separators are normalised and a "../.."
    // in the reported cwd can't climb out of an allowed directory.
    //
    // The trailing separator matters: without it, "/code-secrets" would count as
    // inside an allowlisted "/code".
    const target = resolve(cwd);
    const ok = allowedDirs.some((dir) => target === dir || target.startsWith(dir + sep));
    if (!ok) return `${cwd} is outside JUSTCALLME_ALLOWED_DIRS`;
  }

  return null;
}

/**
 * Have we gone too many calls deep?
 *
 * You answer a call, ask for work; that work finishes and calls you back. That's
 * depth 1. Without a ceiling, a task that somehow re-triggers itself would phone
 * you all night.
 */
export function checkChainDepth(depth, max) {
  if (depth >= max) {
    return `chain depth ${depth} hit the ceiling (JUSTCALLME_MAX_CHAIN=${max})`;
  }
  return null;
}
