/**
 * AUMID (AppUserModelID) registration.
 *
 * Windows attributes toast notifications to an application identity. For
 * unpackaged programs that identity must exist in one of two places:
 *   1. HKCU\Software\Classes\AppUserModelId\<AUMID> with DisplayName / ShowInSettings
 *   2. A Start Menu shortcut carrying the System.AppUserModel.ID property
 *
 * We write both: the registry key alone already names the toast correctly, and
 * the shortcut additionally makes the app visible in Settings > System >
 * Notifications so it can be muted like any other app.
 *
 * All calls are async; see ./ps.js for why.
 */

import { join } from 'node:path'
import { runPowerShell, psQuote } from './ps.js'
import { POWERSHELL_51, AUMID, DISPLAY_NAME, START_MENU_DIR, SHORTCUT_NAME } from './constants.js'
import { log } from './state.js'

/**
 * Writes the registry key and the Start Menu shortcut. Idempotent.
 * @returns {Promise<{ ok: boolean, details: string[] }>}
 */
export async function registerAumid() {
  const details = []

  const regScript = `
$ErrorActionPreference = 'Stop'
$key = 'HKCU:\\Software\\Classes\\AppUserModelId\\${AUMID}'
if (-not (Test-Path $key)) { New-Item -Path $key -Force | Out-Null }
Set-ItemProperty -Path $key -Name 'DisplayName' -Value '${psQuote(DISPLAY_NAME)}' -Type String
Set-ItemProperty -Path $key -Name 'ShowInSettings' -Value 1 -Type DWord
Write-Output 'REGOK'
`

  const reg = await runPowerShell(regScript, { timeoutMs: 30000 })
  if (reg.code === 0 && reg.stdout.includes('REGOK')) {
    details.push('registry: DisplayName + ShowInSettings written')
  } else {
    details.push(`registry: FAILED (${reg.stderr || reg.stdout || 'no output'})`)
    return { ok: false, details }
  }

  // The Start Menu shortcut anchors the AUMID so Windows lists us in Settings.
  const lnkPath = join(START_MENU_DIR, SHORTCUT_NAME)
  const lnkScript = `
$ErrorActionPreference = 'Stop'
$lnk = '${psQuote(lnkPath)}'
$dir = Split-Path -Parent $lnk
if (-not (Test-Path $dir)) { New-Item -ItemType Directory -Path $dir -Force | Out-Null }

$sh = New-Object -ComObject WScript.Shell
$s = $sh.CreateShortcut($lnk)
$s.TargetPath = '${psQuote(POWERSHELL_51)}'
$s.Arguments = '-NoProfile -WindowStyle Hidden -Command "exit"'
$s.Description = '${psQuote(DISPLAY_NAME)}'
$s.Save()
Write-Output 'LNKOK'
`

  const lnk = await runPowerShell(lnkScript, { timeoutMs: 30000 })
  if (lnk.code === 0 && lnk.stdout.includes('LNKOK')) {
    details.push(`shortcut: ${lnkPath}`)
  } else {
    // The shortcut is a nicety; the registry key alone already names the toast.
    details.push(`shortcut: WARN (${lnk.stderr || lnk.stdout || 'no output'})`)
  }

  return { ok: true, details }
}

/** Removes the registry key and shortcut created by registerAumid(). */
export async function unregisterAumid() {
  const details = []
  const script = `
$ErrorActionPreference = 'SilentlyContinue'
$key = 'HKCU:\\Software\\Classes\\AppUserModelId\\${AUMID}'
if (Test-Path $key) { Remove-Item -Path $key -Recurse -Force; Write-Output 'REGREMOVED' }
$lnk = '${psQuote(join(START_MENU_DIR, SHORTCUT_NAME))}'
if (Test-Path $lnk) { Remove-Item -Path $lnk -Force; Write-Output 'LNKREMOVED' }
`
  const res = await runPowerShell(script, { timeoutMs: 30000 })
  if (res.stdout.includes('REGREMOVED')) details.push('registry key removed')
  if (res.stdout.includes('LNKREMOVED')) details.push('shortcut removed')
  if (details.length === 0) details.push('nothing to remove')
  return { ok: true, details }
}

/** Best-effort check that the registration exists. @returns {Promise<boolean>} */
export async function isAumidRegistered() {
  const script = `
$key = 'HKCU:\\Software\\Classes\\AppUserModelId\\${AUMID}'
if (Test-Path $key) {
  $v = (Get-ItemProperty -Path $key -Name DisplayName -ErrorAction SilentlyContinue).DisplayName
  Write-Output "YES|$v"
} else { Write-Output 'NO' }
`
  const res = await runPowerShell(script, { timeoutMs: 20000 })
  return res.stdout.startsWith('YES')
}

/**
 * Makes sure the AUMID exists, registering it on first use.
 *
 * Runs at most once per host process, and never at startup: the plugin should
 * not spend a second of DSH's boot time on a registry key that is almost always
 * already there. The first notification pays the cost instead.
 *
 * @returns {Promise<boolean>} whether the AUMID is usable
 */
let aumidReady = null
export function ensureAumid() {
  if (aumidReady) return aumidReady
  aumidReady = (async () => {
    const registered = await isAumidRegistered()
    if (registered) return true
    log('aumid: not registered, registering now')
    const result = await registerAumid()
    for (const detail of result.details) log(`aumid: ${detail}`)
    return result.ok
  })().catch((err) => {
    log('aumid: ensure failed:', err?.message ?? err)
    aumidReady = null
    return false
  })
  return aumidReady
}
