/**
 * State/logging helpers for dsh-desktop-notifier.
 */

import { appendFileSync, mkdirSync, existsSync, writeFileSync, readFileSync } from 'node:fs';
import { STATE_DIR, LOG_FILE, SETTINGS_FILE, DEFAULT_SETTINGS } from './constants.js';

let logReady = false;

function ensureStateDir() {
  if (!existsSync(STATE_DIR)) {
    mkdirSync(STATE_DIR, { recursive: true });
  }
}

/** Append one line to the log file. Never throws. */
export function log(...parts) {
  const line = `[${new Date().toISOString()}] ${parts.join(' ')}`;
  try {
    if (!logReady) {
      ensureStateDir();
      logReady = true;
    }
    appendFileSync(LOG_FILE, line + '\n', 'utf8');
  } catch {
    // Logging must never break the program.
  }
  // Also mirror to stderr when attached to a console, so `npm start` is useful.
  try {
    process.stderr.write(line + '\n');
  } catch {
    /* ignore */
  }
}

/**
 * Read settings, merging the on-disk file over DEFAULT_SETTINGS.
 * On first run the defaults are written out so the user has something to edit.
 */
export function loadSettings() {
  ensureStateDir();
  if (!existsSync(SETTINGS_FILE)) {
    try {
      writeFileSync(SETTINGS_FILE, JSON.stringify(DEFAULT_SETTINGS, null, 2), 'utf8');
    } catch {
      return { ...DEFAULT_SETTINGS };
    }
    return { ...DEFAULT_SETTINGS };
  }
  try {
    const raw = JSON.parse(readFileSync(SETTINGS_FILE, 'utf8'));
    return {
      ...DEFAULT_SETTINGS,
      ...raw,
      quietHours: { ...DEFAULT_SETTINGS.quietHours, ...(raw.quietHours ?? {}) },
    };
  } catch (err) {
    log('settings parse failed, using defaults:', err.message);
    return { ...DEFAULT_SETTINGS };
  }
}

/** True when `now` falls inside the configured quiet-hours window. */
export function isQuietHours(settings, now = new Date()) {
  const q = settings.quietHours;
  if (!q?.enabled) return false;

  const toMinutes = (hhmm) => {
    const m = /^(\d{1,2}):(\d{2})$/.exec(String(hhmm ?? '').trim());
    if (!m) return null;
    return Number(m[1]) * 60 + Number(m[2]);
  };

  const from = toMinutes(q.from);
  const to = toMinutes(q.to);
  if (from === null || to === null) return false;

  const cur = now.getHours() * 60 + now.getMinutes();
  // A window like 23:00 -> 08:00 wraps past midnight.
  return from <= to ? cur >= from && cur < to : cur >= from || cur < to;
}
