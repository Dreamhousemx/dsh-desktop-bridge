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
   * When false, toasts fire even if you are looking at DSH.
   */
  suppressWhenFocused: true,
  /** Suppress all toasts during this local-time range. Set enabled:false to disable. */
  quietHours: { enabled: false, from: '23:00', to: '08:00' },
}

/** Route the browser half posts events to. */
export const INGEST_PATH = '/__dsh-desktop-bridge/ingest'

/** Route a health probe (or the settings UI) can read without a token. */
export const HEALTH_PATH = '/__dsh-desktop-bridge/health'

/** Global the host injects into index.html carrying the ingest token. */
export const TOKEN_GLOBAL = '__DSH_DESKTOP_BRIDGE__'
