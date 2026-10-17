/**
 * The feature itself: turn session events into Windows toasts.
 *
 * This module owns everything that lives in the host process — the noise-control
 * dispatcher, the toast worker, and the AUMID registration. It exists as its own
 * layer so lib/index.js stays a thin cordis wiring file.
 *
 * Why the toast code runs here rather than in a companion desktop program:
 * notifications no longer need their own process, their own port, or a discovery
 * file. The host process already knows everything and already outlives a page
 * reload, so a second process would only add a failure mode (and did: the
 * standalone build had to watch a JSON file to find its token).
 */

import { Dispatcher } from './host/dispatch.js'
import { loadSettings } from './host/state.js'
import { ensureAumid } from './host/aumid.js'
import { disposeToasts, warmUpToasts } from './host/toast.js'

/**
 * Delay before the PowerShell toast worker is spawned.
 *
 * Starting it during plugin activation would put ~1.2s of PowerShell startup in
 * the middle of DSH's boot. Waiting a few seconds costs nothing — the first
 * notification cannot plausibly arrive before then — and keeps the window
 * responsive.
 */
const WARM_UP_DELAY_MS = 5000

/**
 * @param {{ log: (msg: string, err?: unknown) => void, onShown?: (ev: object, result: string) => void }} deps
 */
export function createNotifier({ log, onShown }) {
  const settings = loadSettings()
  const dispatcher = new Dispatcher(settings)

  /** Counters for the health route; cheap, in-memory, no persistence. */
  const stats = { received: 0, shown: 0, suppressed: 0, lastEventAt: 0 }

  let warmTimer = null
  let disposed = false

  const warmUp = () => {
    if (disposed) return
    warmTimer = null
    ensureAumid()
      .then((ok) => {
        if (disposed) return
        if (!ok) {
          log('notifier: AUMID unavailable; toasts will still be attempted')
        }
        return warmUpToasts()
      })
      .catch((err) => log('notifier: warm-up failed:', err?.message ?? err))
  }

  const handle = async (ev) => {
    stats.received += 1
    stats.lastEventAt = Date.now()
    let result
    try {
      result = await dispatcher.handle(ev)
    } catch (err) {
      log('notifier: dispatch failed:', err?.message ?? err)
      return 'error'
    }
    if (result === 'shown') stats.shown += 1
    else if (result !== 'duplicate') stats.suppressed += 1
    if (onShown) onShown(ev, result)
    return result
  }

  const start = () => {
    if (disposed) return
    warmTimer = setTimeout(warmUp, WARM_UP_DELAY_MS)
    // Never keep DSH alive (or block quit) on account of a warm-up timer.
    if (typeof warmTimer.unref === 'function') warmTimer.unref()
  }

  const dispose = () => {
    if (disposed) return
    disposed = true
    if (warmTimer) {
      clearTimeout(warmTimer)
      warmTimer = null
    }
    try {
      dispatcher.dispose()
    } catch {
      /* ignore */
    }
    try {
      disposeToasts()
    } catch {
      /* ignore */
    }
  }

  return { handle, start, dispose, stats: () => ({ ...stats }), settings }
}
