/**
 * Window focus and activation.
 *
 * Two questions, both answered by Win32 calls the host process cannot make
 * directly (no FFI in Node): "is the DSH window the foreground window right now?"
 * and "bring the DSH window to the front".
 *
 * Windows enforces a "foreground lock": only the process that already owns the
 * foreground window may call SetForegroundWindow successfully; any other caller
 * is silently downgraded to a taskbar flash. The reliable workaround is
 * AttachThreadInput, which temporarily shares the input queue with the thread
 * that owns the foreground, making our call count as legitimate.
 *
 * The Alt-key trick (keybd_event) was tried first and does NOT work from a
 * background process: the injected key only satisfies the lock when it actually
 * reaches the foreground queue.
 *
 * Both helpers are async. `isDshForeground` runs on every completion event, and
 * a blocking PowerShell call there would stutter the GUI.
 */

import { runPowerShell } from './ps.js'
import { log } from './state.js'

/**
 * The window we care about belongs to this executable. Comparing the owning
 * process's image path is the only stable identity here: process NAMES collide
 * across the six Electron processes, and PIDs change every launch.
 */
function identityEnv() {
  return { DSH_NOTIFIER_EXE: process.execPath ?? '' }
}

const FOREGROUND_SCRIPT = `
$ErrorActionPreference = 'Stop'
Add-Type -Namespace Dsh -Name Fg -MemberDefinition @'
[DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
[DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr hWnd, out uint lpdwProcessId);
'@
$fg = [Dsh.Fg]::GetForegroundWindow()
if ($fg -eq [IntPtr]::Zero) { Write-Output 'NONE'; exit 0 }
$fgPid = [uint32]0
[void][Dsh.Fg]::GetWindowThreadProcessId($fg, [ref]$fgPid)
if ($fgPid -eq 0) { Write-Output 'NONE'; exit 0 }
$p = Get-Process -Id $fgPid -ErrorAction SilentlyContinue
if ($null -eq $p) { Write-Output "OTHER|$fgPid"; exit 0 }
$exe = $env:DSH_NOTIFIER_EXE
$path = $null
try { $path = $p.Path } catch { $path = $null }
if ($exe -and $path -and ($path -ieq $exe)) { Write-Output 'DSH' } else { Write-Output "OTHER|$($p.ProcessName)" }
`

/**
 * Reports whether the DSH window currently owns the foreground.
 *
 * Used to decide whether a 'done' toast is worth showing: when you are already
 * looking at DSH, a system toast for "task finished" is noise.
 *
 * @returns {Promise<boolean|null>} null when the check itself failed
 */
export async function isDshForeground() {
  const res = await runPowerShell(FOREGROUND_SCRIPT, { timeoutMs: 10000, env: identityEnv() })
  const out = res.stdout.trim()
  if (out === 'DSH') return true
  if (out === 'NONE' || out.startsWith('OTHER|')) return false
  log('activate: foreground probe failed:', res.stderr || out || '(empty)')
  return null
}

const ACTIVATE_SCRIPT = `
$ErrorActionPreference = 'Stop'

Add-Type -Namespace Dsh -Name Act -MemberDefinition @'
[DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr hWnd);
[DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr hWnd, int nCmdShow);
[DllImport("user32.dll")] public static extern bool IsIconic(IntPtr hWnd);
[DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
[DllImport("user32.dll")] public static extern bool BringWindowToTop(IntPtr hWnd);
[DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr hWnd, out uint lpdwProcessId);
[DllImport("kernel32.dll")] public static extern uint GetCurrentThreadId();
[DllImport("user32.dll")] public static extern bool AttachThreadInput(uint idAttach, uint idAttachTo, bool fAttach);
[DllImport("user32.dll")] public static extern bool SwitchToThisWindow(IntPtr hWnd, bool fAltTab);
'@

$SW_RESTORE = 9
$exe = $env:DSH_NOTIFIER_EXE

# Prefer a window owned by our own image; fall back to any window of the app.
$target = Get-Process -ErrorAction SilentlyContinue |
  Where-Object { $_.MainWindowHandle -ne 0 } |
  Where-Object { $exe -and $_.Path -ieq $exe } |
  Select-Object -First 1

if ($null -eq $target) {
  $target = Get-Process -ErrorAction SilentlyContinue |
    Where-Object { $_.MainWindowHandle -ne 0 -and $_.ProcessName -eq 'DeepSeek Harness' } |
    Select-Object -First 1
}

if ($null -eq $target) { Write-Output 'NOTFOUND'; exit 0 }

$hwnd = $target.MainWindowHandle

if ([Dsh.Act]::IsIconic($hwnd)) {
  [Dsh.Act]::ShowWindow($hwnd, $SW_RESTORE) | Out-Null
  Start-Sleep -Milliseconds 150
}

if ([Dsh.Act]::GetForegroundWindow() -eq $hwnd) {
  Write-Output "ACTIVATED|$($target.Id)|already"
  exit 0
}

$fgHwnd = [Dsh.Act]::GetForegroundWindow()
$curThread = [Dsh.Act]::GetCurrentThreadId()
$fgThread = [uint32]0
if ($fgHwnd -ne [IntPtr]::Zero) {
  [void][Dsh.Act]::GetWindowThreadProcessId($fgHwnd, [ref]$fgThread)
}
$targetThread = [uint32]0
[void][Dsh.Act]::GetWindowThreadProcessId($hwnd, [ref]$targetThread)

$attachedFg = $false
$attachedTarget = $false
try {
  if ($fgThread -ne 0 -and $fgThread -ne $curThread) {
    $attachedFg = [Dsh.Act]::AttachThreadInput($curThread, $fgThread, $true)
  }
  if ($targetThread -ne 0 -and $targetThread -ne $curThread -and $targetThread -ne $fgThread) {
    $attachedTarget = [Dsh.Act]::AttachThreadInput($curThread, $targetThread, $true)
  }

  [Dsh.Act]::BringWindowToTop($hwnd) | Out-Null
  $ok = [Dsh.Act]::SetForegroundWindow($hwnd)

  if ([Dsh.Act]::GetForegroundWindow() -ne $hwnd) {
    [Dsh.Act]::SwitchToThisWindow($hwnd, $true)
    Start-Sleep -Milliseconds 100
  }
} finally {
  if ($attachedTarget) { [Dsh.Act]::AttachThreadInput($curThread, $targetThread, $false) | Out-Null }
  if ($attachedFg) { [Dsh.Act]::AttachThreadInput($curThread, $fgThread, $false) | Out-Null }
}

if ([Dsh.Act]::GetForegroundWindow() -eq $hwnd) {
  Write-Output "ACTIVATED|$($target.Id)"
} else {
  Write-Output "FAILED|$($target.Id)|$ok"
}
`

/**
 * Brings the DSH window to the foreground.
 * @returns {Promise<{ ok: boolean, pid?: number, reason?: string }>}
 */
export async function activateDshWindow() {
  const res = await runPowerShell(ACTIVATE_SCRIPT, { timeoutMs: 15000, env: identityEnv() })
  const out = res.stdout.trim()

  if (out.startsWith('ACTIVATED|')) {
    const [, pidStr] = out.split('|')
    const pid = Number(pidStr)
    log('activate: DSH is foreground now, pid', pid)
    return { ok: true, pid }
  }
  if (out.startsWith('NOTFOUND')) {
    log('activate: DSH window not found')
    return { ok: false, reason: 'not-found' }
  }
  if (out.startsWith('FAILED|')) {
    log('activate: all strategies failed:', out)
    return { ok: false, reason: 'foreground-lock' }
  }
  log('activate: unexpected output:', out || res.stderr || '(empty)')
  return { ok: false, reason: res.stderr || 'unknown' }
}
