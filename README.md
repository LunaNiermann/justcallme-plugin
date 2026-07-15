# Just Call Me — Claude Code plugin

Your coding agent **phones you** when the work is done. Start a long task, walk
away; when it finishes, your iPhone rings with a real call — the agent tells you
what happened, you say what to do next.

This plugin adds:

- **`/callme`** — control when the phone rings (`link`, `once`, `on`/`off`,
  thresholds, quiet hours).
- **A Stop hook** — fires when a Claude Code task finishes and, if it ran long
  enough, rings your phone.
- **A SessionStart hook** — when you sit back down, tells Claude what came in
  while you were away.

## Install

You'll need [Node.js](https://nodejs.org) 20+ and the
[Just Call Me: Agent Callbacks](https://getjustcall.me) app on your iPhone.

> **Install on a Claude Code session running on your computer** — the terminal,
> the desktop app, or an IDE extension — **not a cloud/web session.** The plugin
> does its work on your machine; a cloud sandbox can't ring you about it.

**In the Claude Code terminal:**

```
/plugin marketplace add LunaNiermann/justcallme-plugin
/plugin install justcallme@justcallme
/callme link
```

**In the desktop app or an IDE**, where slash commands may not exist, just ask
Claude in plain language:

> Add the plugin marketplace LunaNiermann/justcallme-plugin, install the
> justcallme plugin, then run callme link.

`link` checks your machine, walks you through getting the iPhone app, and gives
you a link + short code (and a QR where it renders) — open it on your phone, tap
**Confirm**, done. No keys to copy, no environment variables, no config files.

## Everyday use

```
/callme once            ← ring me when THIS task finishes (the one you'll use most)
/callme on              ← turn calls on for this project
/callme threshold 300   ← only call for tasks over 5 minutes
/callme quiet 22:00 08:00
/callme status
```

New projects don't ring until you `/callme on` them — opt-in, not opt-out, so a
forgotten script can't call you during dinner.

## Privacy & safety

- The hook sends the finished task's summary to the Just Call Me service to make
  the call, and nothing else. No code leaves your machine.
- If calls are off, or the task was short, nothing is sent at all.
- Your account key is stored in `~/.justcallme/config.json` on this computer.
  Revoke it any time from the iPhone app.

## Development

The code in `scripts/` is synced from the main repository — don't edit it here.
Hooks and CLI live in the `justcallme` repo under `hooks/`; run
`node scripts/sync-plugin.mjs` there to update this repo, then commit.
