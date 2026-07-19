/**
 * Find the OpenAI Codex CLI to spawn (for away-mode runs).
 *
 * Simpler than claude-bin.mjs: Codex is an ordinary CLI (`npm i -g @openai/codex`, or
 * Homebrew), so it's normally on PATH rather than buried inside a desktop app. Resolution:
 *   1. JUSTCALLME_CODEX_BIN, if set — an explicit override always wins.
 *   2. A few well-known absolute install paths (so a daemon started at login with a thin
 *      PATH still finds a Homebrew / npm-global codex).
 *   3. The bare name `codex`, trusting PATH. On Windows the npm shim is `codex.cmd`, which
 *      Node can't spawn without a shell, so useShell is true there.
 */
import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

export function resolveCodexBin(env = process.env, platform = process.platform) {
  const override = env.JUSTCALLME_CODEX_BIN?.trim();
  if (override) {
    const useShell = platform === 'win32' && !/\.exe$/i.test(override);
    return { bin: override, useShell, source: 'JUSTCALLME_CODEX_BIN' };
  }

  if (platform !== 'win32') {
    for (const p of [
      '/opt/homebrew/bin/codex', // Apple-silicon Homebrew
      '/usr/local/bin/codex', // Intel Homebrew / manual
      join(homedir(), '.local', 'bin', 'codex'),
    ]) {
      if (existsSync(p)) return { bin: p, useShell: false, source: p };
    }
    return { bin: 'codex', useShell: false, source: 'PATH' };
  }

  // Windows: a bare `codex` resolves to codex.cmd, which needs a shell to spawn.
  return { bin: 'codex', useShell: true, source: 'PATH' };
}
