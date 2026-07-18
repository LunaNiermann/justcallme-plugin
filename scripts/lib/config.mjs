/**
 * Who gets called, for what, and when.
 *
 * Lives at ~/.justcallme/config.json so it follows you across every project, rather
 * than being committed into one repo. Environment variables still win over it — a
 * CI box or a shared machine can force the behaviour it wants.
 *
 * The interesting case, and the one that drove the design: you almost never decide
 * "call me about project X" in the abstract. You decide it in the second before you
 * kick off something slow — "this'll take a while, ring me." That's `armOnce()`, and
 * it's why /callme exists.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';

export const CONFIG_DIR = join(homedir(), '.justcallme');
export const CONFIG_PATH = join(CONFIG_DIR, 'config.json');

const DEFAULTS = {
  /** Master switch. Off = never call, whatever else says. */
  enabled: true,
  /** Don't call for anything shorter than this. 0 = call for everything. */
  minSeconds: 600,
  /**
   * Per-project overrides, keyed by project name (the basename of the cwd).
   * { "payments": { "enabled": true, "minSeconds": 0 } }
   */
  projects: {},
  /**
   * Unknown projects: "call" or "skip".
   *
   * Defaults to "skip". Opt-in, not opt-out — the failure mode of the alternative
   * is your phone ringing during dinner because a script you forgot about finished.
   */
  unknownProjects: 'skip',
  /** e.g. { "from": "22:00", "to": "08:00" } in local time. Null = always callable. */
  quietHours: null,
  /**
   * One-shot: "call me when the NEXT task in this project finishes, whatever the
   * rules say". Set by `/callme once`, cleared as soon as it fires.
   */
  once: null,
  /**
   * Keep the machine awake while the listener is serving a project, so a laptop lid
   * or an idle-sleep timer can't swallow a call. True by default; set false for a
   * machine that must be allowed to sleep. Env JUSTCALLME_KEEP_AWAKE overrides.
   * See hooks/lib/keepawake.mjs.
   */
  keepAwake: true,
  /**
   * The background helper runs automatically: every Claude session starts it (reviving
   * a dead one) and registers the project, so there is nothing to set up. This is the
   * one escape hatch — `/callme away off` sets it, stopping the helper and telling
   * SessionStart not to bring it back; `/callme away on` clears it. Whether the helper,
   * once running, actually RUNS an instruction unattended is a SEPARATE gate: the app's
   * execution toggle (default: wait for you). This flag only decides if it runs at all.
   */
  helperDisabled: false,
};

export function loadConfig() {
  if (!existsSync(CONFIG_PATH)) return { ...DEFAULTS };
  try {
    return { ...DEFAULTS, ...JSON.parse(readFileSync(CONFIG_PATH, 'utf8')) };
  } catch {
    // A corrupt config must not break your Claude Code session. Fall back to
    // defaults and carry on — the hook exits 0 no matter what.
    return { ...DEFAULTS };
  }
}

export function saveConfig(config) {
  mkdirSync(dirname(CONFIG_PATH), { recursive: true });
  writeFileSync(CONFIG_PATH, JSON.stringify(config, null, 2) + '\n');
  return config;
}

/** Is `now` inside the quiet window? Handles windows that wrap midnight. */
export function inQuietHours(quietHours, now = new Date()) {
  if (!quietHours?.from || !quietHours?.to) return false;

  const toMinutes = (hhmm) => {
    const [h, m] = hhmm.split(':').map(Number);
    return h * 60 + (m || 0);
  };

  const from = toMinutes(quietHours.from);
  const to = toMinutes(quietHours.to);
  const at = now.getHours() * 60 + now.getMinutes();

  // 22:00 → 08:00 wraps midnight, so the window is "after from OR before to".
  return from > to ? at >= from || at < to : at >= from && at < to;
}

/**
 * The whole decision, in one place.
 *
 * @returns { call: boolean, reason: string, consumeOnce: boolean }
 */
export function shouldCall({ config, project, durationSeconds, now = new Date() }) {
  // A one-shot beats everything, including quiet hours and the master switch. You
  // asked for this call, thirty seconds ago, on purpose. Waking you is the point.
  const once = config.once;
  if (once && (once.project === project || once.project === '*')) {
    return { call: true, reason: `armed by /callme once (${once.project})`, consumeOnce: true };
  }

  if (!config.enabled) {
    return { call: false, reason: 'calling is off (/callme off)', consumeOnce: false };
  }

  if (inQuietHours(config.quietHours, now)) {
    const { from, to } = config.quietHours;
    return { call: false, reason: `quiet hours (${from}–${to})`, consumeOnce: false };
  }

  const rule = config.projects?.[project];

  if (!rule) {
    if (config.unknownProjects === 'skip') {
      return {
        call: false,
        reason: `'${project}' isn't set up for calls — run /callme on in that project`,
        consumeOnce: false,
      };
    }
  } else if (rule.enabled === false) {
    return { call: false, reason: `calling is off for '${project}'`, consumeOnce: false };
  }

  const threshold = rule?.minSeconds ?? config.minSeconds;
  if (durationSeconds < threshold) {
    return {
      call: false,
      reason: `task ran ${durationSeconds}s, under the ${threshold}s threshold`,
      consumeOnce: false,
    };
  }

  return { call: true, reason: `${durationSeconds}s ≥ ${threshold}s`, consumeOnce: false };
}
