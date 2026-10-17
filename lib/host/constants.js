/**
 * Shared constants for the desktop notification feature.
 *
 * The AUMID (AppUserModelID) is the identity Windows uses to attribute a toast
 * to an application. Without a registered AUMID, a toast sent by an unpackaged
 * process either fails to show or appears under a system name such as "Windows
 * PowerShell". Registering our own id lets the toast carry our own header.
 */

import { join } from 'node:path'

/** Application identity used for toasts. Changing this invalidates the registration. */
export const AUMID = 'DeepSeekHarness.TaskNotifier'

/** Display name shown in the toast header and in Windows notification settings. */
export const DISPLAY_NAME = 'DSH 任务提醒'

/** Path to the Windows PowerShell 5.1 host. WinRT projections are unavailable in PowerShell 7. */
export const POWERSHELL_51 = join(
  process.env.SystemRoot ?? 'C:\\Windows',
  'System32',
  'WindowsPowerShell',
  'v1.0',
  'powershell.exe',
)

/** Windows profile directory (Roaming). */
const APPDATA = process.env.APPDATA ?? join(process.env.USERPROFILE ?? '', 'AppData', 'Roaming')

/** Windows local profile directory. */
const LOCALAPPDATA =
  process.env.LOCALAPPDATA ?? join(process.env.USERPROFILE ?? '', 'AppData', 'Local')

/** Start Menu shortcut folder for this user. */
export const START_MENU_DIR = join(APPDATA, 'Microsoft', 'Windows', 'Start Menu', 'Programs')

/** Start Menu shortcut file name anchored to the AUMID registration. */
export const SHORTCUT_NAME = 'DSH Task Notifier.lnk'

/** Local state directory (logs, settings). */
export const STATE_DIR = join(LOCALAPPDATA, 'dsh-desktop-notifier')

/** Log file (append-only). */
export const LOG_FILE = join(STATE_DIR, 'notifier.log')

/** User-editable settings file. */
export const SETTINGS_FILE = join(STATE_DIR, 'settings.json')

/**
 * Default settings. Written to SETTINGS_FILE on first run so the user can edit
 * them; missing keys fall back to these values.
 */
export const DEFAULT_SETTINGS = {
  /** Minimum gap between two toasts of the same kind, in ms. */
  throttleMs: 3000,
  /**
   * Suppress 'done' toasts while the DSH window is the foreground window.
   *
   * Defaults to false: the whole point of the feature is that a finished turn is
   * easy to miss, and "you happen to be looking at the window" is exactly the
   * situation where the page gives no signal of its own. Set it to true to only
   * hear about background sessions.
   */
  suppressWhenFocused: false,
  /** Suppress all toasts during this local-time range. Set enabled:false to disable. */
  quietHours: { enabled: false, from: '23:00', to: '08:00' },
  /**
   * Ask the browser half to POST its view of every sessionStatus publication to
   * the probe route, which logs it. Diagnostic only; off by default.
   */
  debug: false,
}

/** Route the browser half posts events to. */
export const INGEST_PATH = '/__dsh-desktop-bridge/ingest'

/** Route a health probe (or the settings UI) can read without a token. */
export const HEALTH_PATH = '/__dsh-desktop-bridge/health'

/**
 * Route the browser half streams its view of session state to when
 * `settings.debug` is on. Answers "is the renderer even seeing the transition?"
 * without needing DevTools.
 */
export const PROBE_PATH = '/__dsh-desktop-bridge/probe'

/** Global the host injects into index.html carrying the ingest token. */
export const TOKEN_GLOBAL = '__DSH_DESKTOP_BRIDGE__'
