/**
 * A best-effort native desktop notification.
 *
 * Away mode leaves finished work on a `justcallme/*` branch, but the only thing that
 * tells you it happened is the SessionStart handoff — which fires when you next OPEN
 * Claude Code in that project. If you're sitting at the PC doing something else, the
 * branch appears silently. This pops an OS toast the moment it lands, so a callback you
 * approved from the car shows up on the desktop too.
 *
 * No npm dependency: we shell out to whatever the platform already ships —
 *   - Windows: a NotifyIcon balloon via PowerShell (renders as a toast on Win10/11)
 *   - macOS:   osascript `display notification`
 *   - Linux:   notify-send
 *
 * Title and message are handed over through the environment, never interpolated into a
 * shell/script string, so a branch name or instruction with quotes in it can't break
 * (or inject into) the command. Everything here is wrapped so a missing tool or a
 * locked-down desktop can never disturb the listener.
 */

import { spawn } from 'node:child_process';

// A real WinRT toast — Windows 11 shows these reliably, unlike the old NotifyIcon
// balloon, which silently no-shows because a transient process isn't a registered
// notification app. The catch is the AppUserModelID: Windows drops toasts from an
// AppID it doesn't recognise (borrowing PowerShell's own AppID looked plausible but
// showed nothing). So we register our OWN per-user AppID once — a single HKCU key
// under SOFTWARE\Classes\AppUserModelId, no admin, the exact thing a real installer
// writes — and toast under it. If the WinRT path throws (older Windows), fall back to
// the NotifyIcon balloon. Text comes from $env, never parsed as code.
const WIN_PS = `
$ErrorActionPreference = 'Stop'
$title = $env:JCM_NOTIFY_TITLE
$msg = $env:JCM_NOTIFY_MSG
try {
  $appId = 'JustCallMe.Listener'
  $key = "HKCU:\\SOFTWARE\\Classes\\AppUserModelId\\$appId"
  if (-not (Test-Path $key)) { New-Item -Path $key -Force | Out-Null }
  Set-ItemProperty -Path $key -Name DisplayName -Value 'Just Call Me' -Force
  [Windows.UI.Notifications.ToastNotificationManager, Windows.UI.Notifications, ContentType = WindowsRuntime] > $null
  [Windows.UI.Notifications.ToastNotification, Windows.UI.Notifications, ContentType = WindowsRuntime] > $null
  $tpl = [Windows.UI.Notifications.ToastNotificationManager]::GetTemplateContent([Windows.UI.Notifications.ToastTemplateType]::ToastText02)
  $t = $tpl.GetElementsByTagName('text')
  $t.Item(0).AppendChild($tpl.CreateTextNode($title)) > $null
  $t.Item(1).AppendChild($tpl.CreateTextNode($msg)) > $null
  $toast = [Windows.UI.Notifications.ToastNotification]::new($tpl)
  [Windows.UI.Notifications.ToastNotificationManager]::CreateToastNotifier($appId).Show($toast)
} catch {
  Add-Type -AssemblyName System.Windows.Forms
  Add-Type -AssemblyName System.Drawing
  $n = New-Object System.Windows.Forms.NotifyIcon
  $n.Icon = [System.Drawing.SystemIcons]::Information
  $n.Visible = $true
  $n.BalloonTipTitle = $title
  $n.BalloonTipText = $msg
  $n.ShowBalloonTip(8000)
  Start-Sleep -Seconds 6
  $n.Dispose()
}
`;

/** Fire a desktop notification. Never throws; returns nothing. */
export function notifyDesktop(title, message) {
  try {
    const env = { ...process.env, JCM_NOTIFY_TITLE: title, JCM_NOTIFY_MSG: message };
    const opts = { detached: true, stdio: 'ignore', windowsHide: true, env };
    let child;

    if (process.platform === 'win32') {
      child = spawn(
        'powershell',
        ['-NoProfile', '-NonInteractive', '-WindowStyle', 'Hidden', '-Command', WIN_PS],
        opts,
      );
    } else if (process.platform === 'darwin') {
      // `system attribute` pulls the text from the environment — no AppleScript string
      // escaping, so quotes and newlines in a branch name are harmless.
      child = spawn(
        'osascript',
        [
          '-e',
          'display notification (system attribute "JCM_NOTIFY_MSG") with title (system attribute "JCM_NOTIFY_TITLE")',
        ],
        opts,
      );
    } else {
      // notify-send takes title/body as plain argv — again, no shell parsing.
      child = spawn('notify-send', [title, message], opts);
    }

    // If the tool is missing (no notify-send installed, etc.) don't let the async
    // 'error' event become an unhandled exception that takes the listener down.
    child.on('error', () => {});
    child.unref();
  } catch {
    /* a notification is a nicety; never let it disturb the run */
  }
}
