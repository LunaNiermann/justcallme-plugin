/**
 * Find the Claude Code CLI to spawn.
 *
 * The catch on Windows: the CLI ships *inside* the desktop app under a
 * version-numbered folder (…\Claude\claude-code\2.1.209\claude.exe) and is not
 * on PATH. So a bare `claude` fails to spawn with "not recognized", and any path
 * you hardcode dies at the next auto-update when the version folder changes name.
 *
 * Resolution order:
 *   1. JUSTCALLME_CLAUDE_BIN, if you set it — an explicit override always wins.
 *   2. On Windows: the newest claude.exe found under the known install roots.
 *   3. Otherwise the bare name `claude`, trusting PATH (mac/Linux, or Windows
 *      installs that did put it on PATH).
 */
import { existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

/** Compare dotted version strings numerically: "2.1.209" > "2.1.9". */
export function compareVersions(a, b) {
  const pa = a.split('.').map((n) => parseInt(n, 10) || 0);
  const pb = b.split('.').map((n) => parseInt(n, 10) || 0);
  for (let i = 0; i < Math.max(pa.length, pb.length); i += 1) {
    const d = (pa[i] || 0) - (pb[i] || 0);
    if (d !== 0) return d;
  }
  return 0;
}

/** The newest …\claude-code\<version>\claude.exe across the Windows install roots. */
export function findWindowsClaude(env = process.env) {
  const roots = [env.APPDATA, env.LOCALAPPDATA]
    .filter(Boolean)
    .map((base) => join(base, 'Claude', 'claude-code'));

  let best = null;
  for (const root of roots) {
    let entries;
    try {
      entries = readdirSync(root, { withFileTypes: true });
    } catch {
      continue; // root doesn't exist on this machine — fine.
    }
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const exe = join(root, entry.name, 'claude.exe');
      if (!existsSync(exe)) continue;
      if (!best || compareVersions(entry.name, best.version) > 0) {
        best = { exe, version: entry.name };
      }
    }
  }
  return best; // { exe, version } | null
}

/**
 * Resolve the command to spawn. Returns { bin, useShell, source }.
 * `useShell` is true only when we're falling back to a bare name that Windows may
 * resolve as a .cmd shim (which Node cannot spawn without a shell). A concrete
 * .exe path is spawned directly — no shell, so no arg-escaping foot-guns.
 */
export function resolveClaudeBin(env = process.env, platform = process.platform) {
  const override = env.JUSTCALLME_CLAUDE_BIN?.trim();
  if (override) {
    const useShell = platform === 'win32' && !override.toLowerCase().endsWith('.exe');
    return { bin: override, useShell, source: 'JUSTCALLME_CLAUDE_BIN' };
  }

  if (platform === 'win32') {
    const found = findWindowsClaude(env);
    if (found) return { bin: found.exe, useShell: false, source: `auto (${found.version})` };
    // Nothing found; fall through to a bare name and let it fail loudly with a hint.
    return { bin: 'claude', useShell: true, source: 'PATH (not found on disk)' };
  }

  return { bin: 'claude', useShell: false, source: 'PATH' };
}
