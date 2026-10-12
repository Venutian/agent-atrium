/**
 * Bring an app's window to the front: the half of "open this thread" a link cannot do.
 *
 * A link handed to the OS reaches the app, but the server is a background process, and both
 * Windows and most X11 window managers refuse to let a background process pull another app's
 * window forward. So after the link, the window is looked for by app and title and asked to
 * come forward the way each platform allows it.
 *
 * `spec` is `{ names, title }`: `names` are process names on Windows and window classes on
 * Linux, compared without case; `title` narrows to the window whose title contains it, and
 * falls back to the app's first window when none does. Nothing here knows about a harness.
 *
 * Everything fails quietly and returns false — the link has already gone, so a window that
 * could not be found is a smaller miss, not an error to show.
 */
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'

const execFileAsync = promisify(execFile)
const TIMEOUT_MS = 6000

/**
 * Windows: list visible top-level windows, keep the app's, prefer the one with the title, and
 * front it. A transient Alt keypress first is what lets a background process take the
 * foreground; restoring first keeps a minimized window from staying minimized.
 */
const windowsScript = ({ names, title }) => `
$ErrorActionPreference = 'SilentlyContinue'
Add-Type -TypeDefinition @'
using System; using System.Text; using System.Runtime.InteropServices;
public static class AgentAtriumWindows {
  public delegate bool EnumProc(IntPtr h, IntPtr l);
  [DllImport("user32.dll")] public static extern bool EnumWindows(EnumProc cb, IntPtr l);
  [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr h);
  [DllImport("user32.dll", CharSet=CharSet.Unicode)] public static extern int GetWindowText(IntPtr h, StringBuilder s, int n);
  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr h, out uint pid);
  [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr h);
  [DllImport("user32.dll")] public static extern bool ShowWindowAsync(IntPtr h, int cmd);
  [DllImport("user32.dll")] public static extern bool IsIconic(IntPtr h);
  [DllImport("user32.dll")] public static extern void keybd_event(byte k, byte s, uint f, UIntPtr e);
}
'@
$want = @(${names.map((n) => `'${n.toLowerCase().replace(/'/g, "''")}'`).join(', ')})
$title = '${String(title || '').replace(/'/g, "''")}'
$names = @{}
$found = New-Object System.Collections.ArrayList
$cb = [AgentAtriumWindows+EnumProc]{ param($h, $l)
  if ([AgentAtriumWindows]::IsWindowVisible($h)) {
    $sb = New-Object System.Text.StringBuilder 512
    [void][AgentAtriumWindows]::GetWindowText($h, $sb, 512)
    $t = $sb.ToString()
    if ($t) {
      $p = 0; [void][AgentAtriumWindows]::GetWindowThreadProcessId($h, [ref]$p)
      if (-not $names.ContainsKey($p)) { $names[$p] = [string](Get-Process -Id $p).ProcessName }
      if ($want -contains $names[$p].ToLower()) { [void]$found.Add(@{ h = $h; t = $t }) }
    }
  }
  $true
}
[void][AgentAtriumWindows]::EnumWindows($cb, [IntPtr]::Zero)
$pick = $null
if ($title) { $pick = $found | Where-Object { $_.t.Contains($title) } | Select-Object -First 1 }
if (-not $pick) { $pick = $found | Select-Object -First 1 }
if (-not $pick) { exit 1 }
if ([AgentAtriumWindows]::IsIconic($pick.h)) { [void][AgentAtriumWindows]::ShowWindowAsync($pick.h, 9) }
[AgentAtriumWindows]::keybd_event(0xA4, 0, 0, [UIntPtr]::Zero)
[AgentAtriumWindows]::keybd_event(0xA4, 0, 2, [UIntPtr]::Zero)
[void][AgentAtriumWindows]::SetForegroundWindow($pick.h)
'focused'
`

async function focusOnWindows(spec) {
  const encoded = Buffer.from(windowsScript(spec), 'utf16le').toString('base64')
  const { stdout } = await execFileAsync(
    'powershell.exe',
    ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-EncodedCommand', encoded],
    { timeout: TIMEOUT_MS, windowsHide: true }
  )
  return stdout.includes('focused')
}

/** Run a command, returning its stdout, or null when it is missing or fails. */
async function run(cmd, args) {
  try {
    const { stdout } = await execFileAsync(cmd, args, { timeout: TIMEOUT_MS })
    return stdout
  } catch {
    return null
  }
}

/**
 * Linux, X11: `xdotool` when it is installed, else `wmctrl`. Both are common and small; on a
 * Wayland session neither can reach native windows, and the link alone has to do.
 */
async function focusOnLinux({ names, title }) {
  const wanted = names.map((n) => n.toLowerCase())
  const list = await run('wmctrl', ['-lx'])
  if (list !== null) {
    // id  desktop  instance.Class  host  title...
    const windows = list.split('\n').map((line) => line.trim().split(/\s+/)).filter((p) => p.length >= 4)
      .map((p) => ({ id: p[0], cls: p[2].toLowerCase(), title: p.slice(4).join(' ') }))
      .filter((w) => wanted.some((n) => w.cls.split('.').includes(n)))
    const pick = (title && windows.find((w) => w.title.includes(title))) || windows[0]
    if (pick && (await run('wmctrl', ['-i', '-a', pick.id])) !== null) return true
  }
  for (const name of names) {
    const ids = await run('xdotool', ['search', '--onlyvisible', '--class', name])
    if (!ids) continue
    let pick = null
    for (const id of ids.split('\n').filter(Boolean)) {
      pick ??= id
      if (title && (await run('xdotool', ['getwindowname', id]))?.includes(title)) { pick = id; break }
    }
    if (pick && (await run('xdotool', ['windowactivate', pick])) !== null) return true
  }
  return false
}

export async function focusAppWindow(spec) {
  if (!spec || !Array.isArray(spec.names) || !spec.names.length) return false
  const clean = { names: spec.names.filter((n) => typeof n === 'string' && /^[\w .-]{1,40}$/.test(n)), title: typeof spec.title === 'string' ? spec.title.slice(0, 200) : '' }
  if (!clean.names.length) return false
  try {
    if (process.platform === 'win32') return await focusOnWindows(clean)
    if (process.platform === 'linux') return await focusOnLinux(clean)
  } catch { /* fall through */ }
  // macOS: `open` already brings the app that answers a link to the front.
  return false
}

/**
 * Keep trying for a few seconds, without holding up the reply: an app that was closed starts
 * from the link and only has a window once it has loaded, and one that was open takes a moment
 * to switch to the thread before it is the window worth fronting.
 */
export function focusSoon(spec, delays = [700, 1800, 4000]) {
  let done = false
  for (const delay of delays) {
    setTimeout(async () => {
      if (done) return
      if (await focusAppWindow(spec)) done = true
    }, delay).unref?.()
  }
}
