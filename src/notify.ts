import { spawn } from "node:child_process";

// Notification cues. Each is off or on as noted; callers (CLI flags, an
// extension settings UI) can flip them individually.
export interface NotifyOptions {
  // Terminal bell (\x07). Off by default; noisy in an interactive shell.
  bell?: boolean;
  // Windows system sound. Off by default.
  sound?: boolean;
  // Windows tray toast / balloon. On by default.
  toast?: boolean;
}

// Fire-and-forget desktop notification. On Windows, optionally plays a system
// sound and pops a tray toast via a detached PowerShell process (no npm
// dependency). Best-effort: any failure is swallowed.
export function notify(title: string, message: string, opts: NotifyOptions = {}): void {
  const { bell = false, sound = false, toast = true } = opts;
  if (bell) process.stderr.write("\x07");
  if (process.platform !== "win32" || (!sound && !toast)) return;

  // These go inside a PowerShell single-quoted string, so double any embedded
  // single quote per PS escaping rules.
  const t = sanitize(title);
  const m = sanitize(message);
  const lines = ["Add-Type -AssemblyName System.Windows.Forms,System.Drawing;"];
  // Sound first; it survives Focus Assist better than the balloon.
  if (sound) lines.push("[System.Media.SystemSounds]::Asterisk.Play();");
  if (toast) {
    lines.push(
      "$n = New-Object System.Windows.Forms.NotifyIcon;",
      "$n.Icon = [System.Drawing.SystemIcons]::Information;",
      "$n.Visible = $true;",
      `$n.ShowBalloonTip(5000, '${t}', '${m}', [System.Windows.Forms.ToolTipIcon]::Info);`,
    );
  }
  lines.push("Start-Sleep -Seconds 6;"); // keep alive long enough to render
  if (toast) lines.push("$n.Dispose();");
  const ps = lines.join(" ");

  try {
    const child = spawn(
      "powershell",
      ["-NoProfile", "-NonInteractive", "-WindowStyle", "Hidden", "-Command", ps],
      { detached: true, stdio: "ignore" },
    );
    child.unref();
  } catch {
    /* best-effort */
  }
}

function sanitize(s: string): string {
  return s.replace(/'/g, "''").replace(/[\r\n]+/g, " ").slice(0, 200);
}
