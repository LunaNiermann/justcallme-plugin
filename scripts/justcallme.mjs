#!/usr/bin/env node
/**
 * justcallme — control when and for which projects the phone rings.
 *
 *   node hooks/justcallme.mjs status
 *   node hooks/justcallme.mjs once            ← "ring me when THIS one finishes"
 *   node hooks/justcallme.mjs on [project]
 *   node hooks/justcallme.mjs off [project]
 *   node hooks/justcallme.mjs threshold 300
 *   node hooks/justcallme.mjs quiet 22:00 08:00
 *   node hooks/justcallme.mjs quiet off
 *   node hooks/justcallme.mjs upgrade         ← out of minutes? get an upgrade link
 *   node hooks/justcallme.mjs pair            ← connect this computer: scan a QR, done
 *
 * Normally you don't type this — you say `/callme` in Claude Code and it runs this
 * for you. See .claude/commands/callme.md.
 */

import { hostname } from 'node:os';
import { basename } from 'node:path';
import { CONFIG_PATH, inQuietHours, loadConfig, saveConfig } from './lib/config.mjs';
import { resolveCreds, saveCreds } from './lib/creds.mjs';
import {
  LOG_FILE,
  installAutostart,
  isAutostartInstalled,
  isListenerRunning,
  startListener,
  stopListener,
  uninstallAutostart,
} from './lib/daemon.mjs';
import { renderQr } from './lib/qr.mjs';

const [, , cmd, ...args] = process.argv;
const config = loadConfig();
const project = basename(process.cwd());

const fmt = (s) => (s === 0 ? 'always' : `${s}s`);

function status() {
  const rule = config.projects?.[project];
  const master = config.enabled ? 'on' : 'OFF';

  console.log('');
  console.log(`  calling         ${master}`);
  console.log(`  this project    ${project}`);

  if (rule) {
    const state = rule.enabled === false ? 'OFF' : 'on';
    console.log(`                  ${state}, threshold ${fmt(rule.minSeconds ?? config.minSeconds)}`);
  } else {
    console.log(
      `                  not set up${config.unknownProjects === 'skip' ? ' — no calls (run: /callme on)' : ''}`,
    );
  }

  console.log(`  default         ${fmt(config.minSeconds)} threshold`);

  if (config.quietHours) {
    const now = inQuietHours(config.quietHours) ? '  ← in quiet hours right now' : '';
    console.log(`  quiet hours     ${config.quietHours.from}–${config.quietHours.to}${now}`);
  } else {
    console.log('  quiet hours     none');
  }

  if (config.once) {
    console.log(`  armed           yes — next task in '${config.once.project}' will call you`);
  }

  const enabled = Object.entries(config.projects ?? {})
    .filter(([, r]) => r.enabled !== false)
    .map(([p, r]) => `${p} (${fmt(r.minSeconds ?? config.minSeconds)})`);
  if (enabled.length) console.log(`  projects        ${enabled.join(', ')}`);

  console.log('');
  console.log(`  ${CONFIG_PATH}`);
  console.log('');
}

/**
 * Is the whole chain actually wired up?
 *
 * Keys do NOT expire and are NOT tied to an app version or install — they live in
 * Postgres against your user id, so updating or reinstalling the app doesn't touch
 * them. But three things fail identically (the phone just doesn't ring) and none of
 * them used to say so: a missing key, a revoked key, and a valid key with no device
 * registered. This asks.
 */
async function doctor() {
  const envCreds = resolveCreds();
  const fileCreds = resolveCreds({ ignoreEnv: true });

  const ok = (m) => console.log(`  [OK]   ${m}`);
  const bad = (m) => console.log(`  [FAIL] ${m}`);
  const warn = (m) => console.log(`  [warn] ${m}`);

  console.log('');

  const url = envCreds.apiUrl ?? fileCreds.apiUrl;
  if (!url) return bad('no API URL — set JUSTCALLME_API_URL or run: justcallme.mjs pair'), console.log('');
  ok(`API URL: ${url} (from ${envCreds.source})`);

  // Try the env key first (it's what wins at runtime), but don't stop there: a
  // stale exported key sitting in front of a healthy paired key is the most
  // common broken state, and doctor's whole job is telling those two apart.
  let key = envCreds.apiKey;
  if (key && fileCreds.apiKey && fileCreds.apiKey !== key) {
    try {
      const res = await fetch(`${url}/keys/verify`, {
        headers: { authorization: `Bearer ${key}` },
        signal: AbortSignal.timeout(15_000),
      });
      if (res.status === 401) {
        warn('the key in your ENVIRONMENT is dead; the paired key in config.json is used instead');
        warn('(clear JUSTCALLME_API_KEY from your shell/profile to silence this)');
        key = fileCreds.apiKey;
      }
    } catch {
      /* API unreachable — the main check below will say so */
    }
  }
  key ??= fileCreds.apiKey;

  if (!key) return bad('no API key — set JUSTCALLME_API_KEY or run: justcallme.mjs pair'), console.log('');
  if (!key.startsWith('jcm_')) return bad('JUSTCALLME_API_KEY does not look like a jcm_ key'), console.log('');
  ok(`key: ${key.slice(0, 10)}…`);

  try {
    const res = await fetch(`${url}/keys/verify`, {
      headers: { authorization: `Bearer ${key}` },
      signal: AbortSignal.timeout(20_000),
    });

    if (res.status === 401) {
      bad('the API rejected this key (401) — it was revoked, or it is from another account');
      console.log('         Mint a fresh one in the app and update JUSTCALLME_API_KEY.');
      console.log('');
      return;
    }
    if (!res.ok) {
      bad(`API returned ${res.status}: ${(await res.text()).slice(0, 100)}`);
      console.log('');
      return;
    }

    const info = await res.json();
    ok('the key is valid and active');
    if (info.last_used_at) ok(`last used: ${new Date(info.last_used_at).toLocaleString()}`);

    if (info.can_ring) {
      ok(`${info.devices} device(s) registered — a call would reach your phone`);
    } else {
      bad('NO DEVICES REGISTERED — the key works, but there is nothing to ring.');
      console.log('         Open the app and sign in; it registers a push token on launch.');
    }
  } catch (err) {
    bad(`could not reach the API: ${err.message}`);
  }

  console.log('');
}

/**
 * "I'm out of minutes — how do I get more?"
 *
 * Fetches a short-lived, pre-authed upgrade link from the API and prints it. Billing
 * lives entirely on the web (getjustcall.me + Stripe); nothing is sold in the app or
 * here. The link carries your identity so the site opens already signed in as you.
 */
async function upgrade() {
  const { apiUrl: url, apiKey: key } = resolveCreds();

  console.log('');
  if (!url || !key) {
    console.log('  No API credentials yet — run `justcallme.mjs pair`, or set');
    console.log('  JUSTCALLME_API_URL and JUSTCALLME_API_KEY.');
    console.log('');
    return;
  }

  try {
    const res = await fetch(`${url}/billing/upgrade-link`, {
      method: 'POST',
      headers: { authorization: `Bearer ${key}`, 'content-type': 'application/json' },
      body: '{}',
      signal: AbortSignal.timeout(20_000),
    });

    if (!res.ok) {
      console.log(`  Couldn't get an upgrade link (${res.status}). Run \`justcallme.mjs doctor\`.`);
      console.log('');
      return;
    }

    const { url: link } = await res.json();
    console.log('  Add minutes or move to a paid plan here — opens getjustcall.me already');
    console.log('  signed in as you. The link expires in 30 minutes:');
    console.log('');
    console.log(`    ${link}`);
    console.log('');
  } catch (err) {
    console.log(`  Couldn't reach the API: ${err.message}`);
    console.log('');
  }
}

/**
 * Pair this computer with your account — no key to copy.
 *
 * The TV-login flow: we show a QR (and the same thing as a typable URL + code),
 * you scan it with your phone, tap Confirm on getjustcall.me while signed in,
 * and the freshly minted key arrives on our next poll. It's saved into
 * ~/.justcallme/config.json, where the hook, the listener, and this CLI all
 * find it — no env vars, no new terminal needed.
 */
const DEFAULT_API = 'https://justcallme-api.onrender.com';
const DEFAULT_WEB = 'https://getjustcall.me';

function pairUrls() {
  return {
    apiUrl: (process.env.JUSTCALLME_API_URL ?? resolveCreds().apiUrl ?? DEFAULT_API).replace(/\/$/, ''),
    webUrl: (process.env.JUSTCALLME_WEB_URL ?? DEFAULT_WEB).replace(/\/$/, ''),
  };
}

/** POST /pair/start → { code, poll_secret, expires_in_seconds } | null (printed why). */
async function startPairing(apiUrl) {
  try {
    const res = await fetch(`${apiUrl}/pair/start`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ device_label: hostname() }),
      signal: AbortSignal.timeout(20_000),
    });
    if (!res.ok) {
      console.log(`  Couldn't start pairing (${res.status}). Is the API up?`);
      console.log('');
      return null;
    }
    return await res.json();
  } catch (err) {
    console.log(`  Couldn't reach the API: ${err.message}`);
    console.log('');
    return null;
  }
}

function printPairQr(webUrl, code) {
  // `?c=`, not `?code=`: supabase-js owns `?code=` on that page (PKCE) and
  // strips it during a magic-link sign-in, eating the pairing code with it.
  //
  // Link and code come FIRST: chat UIs (Claude desktop, IDEs) render the
  // half-block QR with broken line-height and it won't scan there — the URL is
  // the path that works everywhere. The QR is a bonus for real terminals.
  const url = `${webUrl}/pair?c=${code}`;
  console.log('  On your phone, open:');
  console.log('');
  console.log(`      ${url}`);
  console.log('');
  console.log(`  and check the code matches:   ${code}`);
  console.log(`  (or go to ${webUrl}/pair and type the code in)`);
  console.log('');
  console.log('  In a terminal you can also scan this:');
  console.log('');
  console.log(renderQr(url).replace(/^/gm, '  '));
  console.log('');
}

/**
 * Poll until the phone confirms. Returns true (key saved) or false.
 * `deadline` is epoch ms — the session's expiry, or sooner if the caller has a
 * shorter patience (a tool-run under Claude shouldn't block for the full TTL).
 */
async function pollForKey({ apiUrl, code, pollSecret, deadline }) {
  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 3000));
    let res;
    try {
      res = await fetch(`${apiUrl}/pair/${code}/poll`, {
        headers: { 'x-poll-secret': pollSecret },
        signal: AbortSignal.timeout(15_000),
      });
    } catch {
      continue; // a network blip mid-poll is not a reason to abandon the pairing
    }

    if (res.status === 410) {
      console.log('\n  This code was already used or has expired. Run pair again.');
      console.log('');
      return false;
    }
    if (!res.ok) continue;

    const body = await res.json();
    if (body.status !== 'ready') continue;

    saveCreds({ apiUrl, apiKey: body.api_key });
    console.log('');
    console.log('  Paired ✓  The key is saved in ~/.justcallme/config.json — the hook,');
    console.log('  the listener, and /callme all use it from there automatically.');
    console.log('');
    return true;
  }
  return false;
}

async function pair() {
  const { apiUrl, webUrl } = pairUrls();
  console.log('');

  const session = await startPairing(apiUrl);
  if (!session) return false;

  const { code, poll_secret, expires_in_seconds } = session;
  // `?c=`, not `?code=`: supabase-js owns `?code=` on that page (PKCE) and
  printPairQr(webUrl, code);
  console.log('  Waiting for you to confirm on your phone…');

  const paired = await pollForKey({
    apiUrl,
    code,
    pollSecret: poll_secret,
    deadline: Date.now() + expires_in_seconds * 1000,
  });
  if (paired) {
    console.log('  Check the whole chain with:  justcallme.mjs doctor');
    console.log('');
    return true;
  }

  console.log('\n  The code expired before it was confirmed (they live 10 minutes).');
  console.log('  Run pair again when your phone is handy.');
  console.log('');
  return false;
}

/**
 * `link` — the guided first-run. This is the front door for a new user who just
 * installed the plugin: sanity-check the machine, point them at the iOS app,
 * then start the QR pairing.
 *
 * TWO steps on purpose: `link` prints the QR and EXITS; `link wait` polls for
 * the confirmation. When Claude runs these as tool calls, the user only sees a
 * command's output once it finishes — a single command that prints the QR and
 * then blocks would show the QR to nobody while it waits for a scan of it.
 * (Exactly that shipped first: the API logged poll after poll for a code no
 * human had ever seen.) The pending session is stashed in the config file so
 * `link wait` — a separate process — can pick it up.
 */
async function link() {
  const ok = (m) => console.log(`  [OK]   ${m}`);
  const bad = (m) => console.log(`  [FAIL] ${m}`);
  const apiUrl = (process.env.JUSTCALLME_API_URL ?? 'https://justcallme-api.onrender.com').replace(/\/$/, '');

  console.log('\n  Just Call Me — let\'s get you set up.\n');

  // --- checks ---------------------------------------------------------------
  const [major] = process.versions.node.split('.').map(Number);
  if (major >= 20) ok(`Node ${process.versions.node}`);
  else {
    bad(`Node ${process.versions.node} — need 20 or newer. Install from nodejs.org and retry.`);
    console.log('');
    return;
  }

  try {
    saveConfig(loadConfig()); // proves ~/.justcallme is writable
    ok('config directory is writable (~/.justcallme)');
  } catch (err) {
    bad(`cannot write ~/.justcallme: ${err.message}`);
    console.log('');
    return;
  }

  try {
    const res = await fetch(`${apiUrl}/healthz`, { signal: AbortSignal.timeout(15_000) });
    if (res.ok) ok('the Just Call Me service is reachable');
    else {
      bad(`the service answered ${res.status} — try again in a minute`);
      console.log('');
      return;
    }
  } catch (err) {
    bad(`cannot reach the service: ${err.message}`);
    console.log('');
    return;
  }

  // Already linked? Don't pair again silently — say so. Check BOTH candidate
  // keys: env first, then the paired key in config.json — a stale exported key
  // must not hide a perfectly good paired one (it did: link re-paired machines
  // that were already linked, because the dead env key outranked the live key).
  const candidates = [resolveCreds().apiKey, resolveCreds({ ignoreEnv: true }).apiKey]
    .filter((k, i, all) => k && all.indexOf(k) === i);
  for (const key of candidates) {
    try {
      const res = await fetch(`${apiUrl}/keys/verify`, {
        headers: { authorization: `Bearer ${key}` },
        signal: AbortSignal.timeout(15_000),
      });
      if (res.ok) {
        const info = await res.json();
        ok(`this computer is already linked${info.can_ring ? ' — a call would reach your phone' : ''}`);
        if (!info.can_ring) {
          console.log('         …but no phone is registered. Sign in on the iOS app and it will be.');
        }
        console.log('\n  Try `/callme status` to see what\'s on, or `/callme once` before a long task.\n');
        return;
      }
    } catch {
      /* verification failed — try the next candidate, else pair fresh */
    }
  }

  // --- the phone side --------------------------------------------------------
  console.log('');
  console.log('  One thing before the QR code:');
  console.log('');
  console.log('  📱 Get the iPhone app — search the App Store for');
  console.log('     "Just Call Me: Agent Callbacks" — and create your account in it.');
  console.log('     (Already done? Carry straight on.)');
  console.log('');

  const { webUrl } = pairUrls();
  const session = await startPairing(apiUrl);
  if (!session) return;

  printPairQr(webUrl, session.code);

  // Stash the session so `link wait` (a separate process) can poll for it.
  const config = loadConfig();
  config.pendingPair = {
    apiUrl,
    code: session.code,
    pollSecret: session.poll_secret,
    expiresAt: Date.now() + session.expires_in_seconds * 1000,
  };
  saveConfig(config);

  console.log('  The code is valid for 10 minutes. Once you have scanned and confirmed');
  console.log('  on your phone, finish with:   link wait');
}

/** `link wait` — poll the pending pairing session until the phone confirms. */
async function linkWait() {
  const config = loadConfig();
  const pending = config.pendingPair;

  console.log('');
  if (!pending?.code || !pending?.pollSecret) {
    console.log('  No pairing in progress. Start one with:  link');
    console.log('');
    return;
  }
  if (Date.now() >= pending.expiresAt) {
    delete config.pendingPair;
    saveConfig(config);
    console.log('  That pairing code has expired (they live 10 minutes).');
    console.log('  Start a fresh one with:  link');
    console.log('');
    return;
  }

  console.log(`  Waiting for you to confirm code ${pending.code} on your phone…`);

  const paired = await pollForKey({
    apiUrl: pending.apiUrl,
    code: pending.code,
    pollSecret: pending.pollSecret,
    deadline: pending.expiresAt,
  });

  // RELOAD before clearing: pollForKey just wrote the api key through its own
  // load/save, and saving our pre-poll snapshot would silently erase it.
  const fresh = loadConfig();
  delete fresh.pendingPair; // one-shot either way — a dead session is not worth keeping
  saveConfig(fresh);

  if (!paired) {
    console.log('  Not confirmed in time. Start a fresh code with:  link');
    console.log('');
    return;
  }

  console.log('  You\'re linked. Here\'s everything you can do:');
  console.log('');
  console.log('    /callme once               ring me when THIS task finishes — the one you\'ll use');
  console.log('    /callme on | off           calls on/off for the current project (new projects');
  console.log('                               are silent until you turn them on)');
  console.log('    /callme threshold 300      only call for tasks over 5 minutes (default 10)');
  console.log('    /callme quiet 22:00 08:00  no calls at night — a `once` still gets through');
  console.log('    /callme status             what\'s armed, on, and thresholded');
  console.log('    /callme doctor             would a call actually reach your phone?');
  console.log('');
  console.log('  Or just say it: "call me when this is done" works too.');
  console.log('');
}

/**
 * `away` — "do it while I'm away", per project.
 *
 *   away on       this project's confirmed instructions run unattended, in an
 *                 isolated worktree on a justcallme/* branch (never merged,
 *                 never pushed). Starts the helper daemon and registers it to
 *                 start at login, so there is no terminal to babysit.
 *   away off      this project always waits for you, whatever the app toggle says
 *   away clear    remove this project's override (the app toggle decides again)
 *   away status   is the helper alive, what's opted in, where the log is
 *
 * The app's Settings toggle is the account-wide DEFAULT; these are per-project
 * overrides on this machine. Opting a project in also adds its directory to the
 * daemon's allowlist — the listener refuses to run anywhere it wasn't invited.
 */
async function away(sub) {
  const cwd = process.cwd();

  console.log('');

  if (sub === 'on') {
    config.projects[project] = { ...(config.projects[project] ?? {}), away: true };
    const dirs = new Set(Array.isArray(config.awayDirs) ? config.awayDirs : []);
    dirs.add(cwd);
    config.awayDirs = [...dirs];
    // The setting that makes unattended runs actually run (edits auto-accepted;
    // the isolation is the worktree + branch, and your review is the gate).
    // Written into the config where you can see and change it, not hidden in an env.
    config.claudeArgs ??= '--permission-mode acceptEdits';
    saveConfig(config);

    const pid = startListener();
    const auto = isAutostartInstalled() ? 'already set' : installAutostart();

    console.log(`  Away mode ON for '${project}'.`);
    console.log('');
    console.log('  When you confirm an instruction on a call from this project, it runs');
    console.log('  here unattended — in an isolated copy, on a justcallme/* branch that is');
    console.log('  never merged or pushed. You review the branch when you are back; the');
    console.log('  next Claude session here will point you at it.');
    console.log('');
    console.log(`  helper       running (pid ${pid})`);
    console.log(`  at login     ${auto}`);
    console.log(`  may run in   ${config.awayDirs.join(', ')}`);
    console.log(`  log          ${LOG_FILE}`);
    console.log('');
    return;
  }

  if (sub === 'off' || sub === 'clear') {
    if (sub === 'off') {
      config.projects[project] = { ...(config.projects[project] ?? {}), away: false };
    } else if (config.projects[project]) {
      delete config.projects[project].away;
    }
    config.awayDirs = (Array.isArray(config.awayDirs) ? config.awayDirs : []).filter(
      (d) => d !== cwd,
    );
    saveConfig(config);

    console.log(
      sub === 'off'
        ? `  Away mode OFF for '${project}' — its instructions always wait for you.`
        : `  Override cleared for '${project}' — the app's toggle decides again.`,
    );

    const anyAway = Object.values(config.projects ?? {}).some((r) => r.away === true);
    if (!anyAway && config.awayDirs.length === 0) {
      const stopped = stopListener();
      uninstallAutostart();
      if (stopped) console.log('  No projects left in away mode — helper stopped and unregistered.');
    }
    console.log('');
    return;
  }

  // status (default)
  const pid = isListenerRunning();
  const awayProjects = Object.entries(config.projects ?? {})
    .filter(([, r]) => r.away === true)
    .map(([p]) => p);
  const askProjects = Object.entries(config.projects ?? {})
    .filter(([, r]) => r.away === false)
    .map(([p]) => p);

  console.log(`  helper       ${pid ? `running (pid ${pid})` : 'NOT running'}`);
  console.log(`  at login     ${isAutostartInstalled() ? 'registered' : 'not registered'}`);
  console.log(`  away on      ${awayProjects.length ? awayProjects.join(', ') : '(none — the app toggle decides)'}`);
  if (askProjects.length) console.log(`  always ask   ${askProjects.join(', ')}`);
  if (Array.isArray(config.awayDirs) && config.awayDirs.length) {
    console.log(`  may run in   ${config.awayDirs.join(', ')}`);
  }
  console.log(`  log          ${LOG_FILE}`);
  console.log('');
  console.log('  The app\'s Settings toggle is the default for projects without an override.');
  console.log('  /callme away on   (in a project) opts it in on this machine.');
  console.log('');
}

switch (cmd) {
  case 'status':
  case undefined:
    status();
    break;

  case 'away':
    await away(args[0] ?? 'status');
    break;

  case 'doctor':
    await doctor();
    break;

  case 'upgrade':
    await upgrade();
    break;

  case 'pair':
    await pair();
    break;

  case 'link':
    if (args[0] === 'wait') await linkWait();
    else await link();
    break;

  // The one that matters. You're about to start something slow.
  case 'once': {
    const target = args[0] ?? project;
    config.once = { project: target };
    saveConfig(config);
    console.log(`\n  Armed. The next task to finish in '${target}' will ring you,`);
    console.log('  regardless of threshold, quiet hours, or the master switch.\n');
    break;
  }

  case 'on': {
    const target = args[0] ?? project;
    config.enabled = true;
    config.projects[target] = { ...(config.projects[target] ?? {}), enabled: true };
    saveConfig(config);
    console.log(
      `\n  Calls ON for '${target}' (threshold ${fmt(config.projects[target].minSeconds ?? config.minSeconds)}).\n`,
    );
    break;
  }

  case 'off': {
    // `off` with no argument means this project. `off --all` is the master switch —
    // deliberately awkward, because silencing everything by accident is how you miss
    // the call you actually wanted.
    if (args[0] === '--all') {
      config.enabled = false;
      saveConfig(config);
      console.log('\n  Calls OFF everywhere. /callme on to bring them back.\n');
      break;
    }
    const target = args[0] ?? project;
    config.projects[target] = { ...(config.projects[target] ?? {}), enabled: false };
    saveConfig(config);
    console.log(`\n  Calls OFF for '${target}'.\n`);
    break;
  }

  case 'threshold': {
    const seconds = Number(args[0]);
    if (!Number.isFinite(seconds) || seconds < 0) {
      console.error('  usage: threshold <seconds>   (0 = call for everything)');
      process.exit(1);
    }
    // With a project argument it's per-project; without, it's the default.
    const target = args[1];
    if (target) {
      config.projects[target] = { ...(config.projects[target] ?? {}), minSeconds: seconds };
      console.log(`\n  '${target}' will call you for tasks over ${fmt(seconds)}.\n`);
    } else {
      config.minSeconds = seconds;
      console.log(`\n  Default threshold: ${fmt(seconds)}.\n`);
    }
    saveConfig(config);
    break;
  }

  case 'quiet': {
    if (args[0] === 'off' || args[0] === 'none') {
      config.quietHours = null;
      saveConfig(config);
      console.log('\n  Quiet hours removed. Callable any time.\n');
      break;
    }
    const [from, to] = args;
    if (!/^\d{1,2}:\d{2}$/.test(from ?? '') || !/^\d{1,2}:\d{2}$/.test(to ?? '')) {
      console.error('  usage: quiet 22:00 08:00   |   quiet off');
      process.exit(1);
    }
    config.quietHours = { from, to };
    saveConfig(config);
    console.log(`\n  Quiet ${from}–${to}. A /callme once still gets through.\n`);
    break;
  }

  default:
    console.error(`  unknown command: ${cmd}`);
    console.error('  try: link | status | once | on | off | away | threshold | quiet | pair | upgrade | doctor');
    process.exit(1);
}
