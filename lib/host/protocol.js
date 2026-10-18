/**
 * The event shape the browser half sends and the host half dispatches.
 *
 * Both halves live in this one plugin, so this file is the single source of
 * truth for the wire format: lib/client.js posts `{kind, sessionId, title,
 * detail, at}` and lib/ingest.js normalises it through {@link makeEvent}, which
 * stamps the protocol version and a stable dedupe key.
 */

export const PROTOCOL_VERSION = 1

/**
 * Notification kinds.
 *
 * waiting -> the session is blocked on something only a human can resolve
 *            (approval prompt, multiple-choice question, plan review).
 * done    -> the session finished running.
 * failed  -> the session stopped because the turn errored out. Separate from
 *            `done` because "任务已完成" over a failed turn is actively
 *            misleading: the user is told the work is finished when in fact
 *            nothing was produced and they usually have to retry.
 */
export const NOTIFY_KIND = {
  waiting: 'waiting',
  done: 'done',
  failed: 'failed',
}

/** Every kind that may appear on the wire. */
export const NOTIFY_KINDS = Object.values(NOTIFY_KIND)

/**
 * @typedef {object} NotifyEvent
 * @property {1} v            protocol version
 * @property {'waiting'|'done'|'failed'} kind
 * @property {string} sessionId
 * @property {string} title       human-readable session title, may be ''
 * @property {string} detail      extra line, e.g. the pending interaction label
 * @property {number} at          epoch ms when the event happened
 * @property {boolean|undefined} isMain
 *   Whether this session is the one occupying the main view. Only the page knows
 *   that, and only the host can tell whether DSH is the foreground window, so the
 *   two halves have to meet: "suppress when focused" means "do not tell me about
 *   the session I am literally looking at", not "stay silent about every other
 *   session because one of them is on screen".
 * @property {string} dedupeKey   stable key; the same key must not toast twice
 */

/**
 * Builds the dedupe key for an event.
 *
 * The key includes the second the event happened in, so answering one prompt and
 * immediately hitting the next prompt in the same session still notifies, while a
 * duplicated delivery of the *same* event is dropped.
 *
 * @param {'waiting'|'done'|'failed'} kind
 * @param {string} sessionId
 * @param {number} at
 */
export function makeDedupeKey(kind, sessionId, at) {
  return `${kind}:${sessionId}:${Math.floor(at / 1000)}`
}

/**
 * Normalises an inbound payload into a complete event.
 *
 * @param {{ kind?: string, sessionId?: string, title?: string, detail?: string, at?: number }} raw
 * @returns {NotifyEvent | null} null when the payload cannot describe an event
 */
export function makeEvent(raw) {
  const kind = NOTIFY_KINDS.includes(raw.kind) ? raw.kind : null
  const sessionId = typeof raw.sessionId === 'string' ? raw.sessionId : ''
  if (!kind || !sessionId) return null

  const at = typeof raw.at === 'number' && Number.isFinite(raw.at) ? raw.at : Date.now()
  return {
    v: PROTOCOL_VERSION,
    kind,
    sessionId,
    title: typeof raw.title === 'string' ? raw.title : '',
    detail: typeof raw.detail === 'string' ? raw.detail : '',
    // Left undefined when absent: the focus gate then treats the event as "on
    // screen", which is the conservative choice for a client that cannot say.
    isMain: raw.isMain === true ? true : raw.isMain === false ? false : undefined,
    at,
    dedupeKey: makeDedupeKey(kind, sessionId, at),
  }
}

/** Validates an already-normalised event. Returns an error string or null. */
export function validateEvent(ev) {
  if (!ev || typeof ev !== 'object') return 'not an object'
  if (ev.v !== PROTOCOL_VERSION) return `unsupported protocol version ${ev.v}`
  if (!NOTIFY_KINDS.includes(ev.kind)) return `unknown kind ${ev.kind}`
  if (typeof ev.sessionId !== 'string' || ev.sessionId === '') return 'missing sessionId'
  if (typeof ev.at !== 'number' || !Number.isFinite(ev.at)) return 'missing at'
  return null
}
