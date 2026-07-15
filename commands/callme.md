---
description: Control when Just Call Me phones you — link this computer, arm a one-shot, toggle a project, set thresholds or quiet hours
argument-hint: "[link | once | on | off | status | threshold <s> | quiet 22:00 08:00 | pair | upgrade | doctor]"
allowed-tools: Bash(node*justcallme.mjs*)
---

Run the Just Call Me CLI and report what changed, briefly.

Run the CLI with Bash, passing `$ARGUMENTS` through unchanged. If the user gave no
arguments, run `status`.

```
node "${CLAUDE_PLUGIN_ROOT}/scripts/justcallme.mjs" $ARGUMENTS
```

## Linking is TWO commands, in order — this matters

`link` prints a QR code and exits; `link wait` blocks until the user has scanned
it. Never skip straight to `link wait`, and never expect `link` itself to wait.

1. Run `link`. **Relay its output to the user immediately and verbatim** —
   especially the QR code block, exactly as printed, monospaced and unmangled
   (it must scan off the screen). Tell them to scan it with their iPhone camera
   and tap Confirm.
2. Then run `link wait` with a Bash timeout of 600000 (10 minutes). It returns
   the moment they confirm on the phone. If it times out or reports expiry, run
   `link` again for a fresh code.

`pair` (without the checks) blocks in one step and is for humans at a real
terminal — prefer `link` + `link wait` when you are driving.

The CLI reads the **current working directory** to know which project it's acting on,
so run it from wherever the user already is — do NOT `cd` anywhere first.

Then relay the result in one or two lines. Don't re-print the whole table unless they
asked for `status`.

## What the subcommands mean

- **`link`** — the guided first-run: checks the machine, points the user at the iOS
  app ("Just Call Me: Agent Callbacks" on the App Store), then shows a QR code to
  pair this computer with their account. Follow with `link wait` (see above). If the
  user just installed this plugin, or says "set this up" / "get me started", run
  this. Safe to re-run: it detects an existing link and says so.
- **`link wait`** — step two of linking: waits (up to 10 min) for the user to
  confirm the scanned code on their phone. Only meaningful right after `link`.
- **`once`** — the important one. "Ring me when *this* task finishes", regardless of
  threshold, quiet hours, or the master switch. The user is about to start something
  slow and is walking away. It fires exactly once and disarms itself.
- **`on` / `off`** — turn calls on or off for the current project. `off --all` is the
  master switch.
- **`threshold <seconds>`** — don't call for tasks shorter than this. `0` = call for
  everything. With a trailing project name, it applies to that project only.
- **`quiet 22:00 08:00`** — no calls in that window. A `once` still gets through, by
  design: if the user explicitly armed a call thirty seconds ago, waking them is the
  entire point.
- **`status`** — what's currently armed, on, and thresholded.
- **`pair`** — just the QR pairing step, without the first-run checks. Use `link`
  unless the user specifically asks to re-pair.
- **`upgrade`** — for when you've used up your free minutes. Prints a personal,
  pre-authed link to getjustcall.me to add minutes or move to a paid plan. Billing is
  web-only; nothing is sold in the app. If the user says "I'm out of minutes" or "how
  do I upgrade / add minutes", run this.
- **`doctor`** — health check: is the key valid, is a phone registered, would a call
  actually ring.

## Notes

New projects do not get calls until someone runs `/callme on` in them. That's
deliberate: opt-in, not opt-out. The failure mode of the alternative is the user's
phone ringing during dinner because of a script they forgot about.

If the user says something like "call me when this is done" or "let me know when
you've finished this", that's `once` — just run it, don't ask which subcommand they
meant.

If a command fails because no credentials are set up, suggest `/callme link`.
