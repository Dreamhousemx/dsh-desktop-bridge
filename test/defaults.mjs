/**
 * Guards the shipped defaults.
 *
 * These assertions look trivial, and that is the point: the first version of this
 * plugin defaulted `suppressWhenFocused` to true and every completion toast was
 * silently dropped while the window happened to be in front, which made the
 * feature look completely broken. Defaults are behaviour; they get a test.
 */

import { DEFAULT_SETTINGS, HEALTH_PATH, INGEST_PATH, PROBE_PATH, TOKEN_GLOBAL } from '../lib/host/constants.js'
import { NOTIFY_KIND, NOTIFY_KINDS, PROTOCOL_VERSION, makeEvent, validateEvent } from '../lib/host/protocol.js'

let failures = 0

function check(label, ok, detail) {
  if (ok) {
    console.log(`  ok  ${label}`)
  } else {
    failures += 1
    console.log(`  FAIL ${label}${detail ? ` — ${detail}` : ''}`)
  }
}

console.log('defaults')
check('suppressWhenFocused defaults to false', DEFAULT_SETTINGS.suppressWhenFocused === false, String(DEFAULT_SETTINGS.suppressWhenFocused))
check('debug tracing defaults to off', DEFAULT_SETTINGS.debug === false, String(DEFAULT_SETTINGS.debug))
check('throttle window is 3s', DEFAULT_SETTINGS.throttleMs === 3000, String(DEFAULT_SETTINGS.throttleMs))
check('quiet hours default to off', DEFAULT_SETTINGS.quietHours.enabled === false)

console.log('\nroutes')
check('ingest route is namespaced', INGEST_PATH.startsWith('/__dsh-desktop-bridge/'), INGEST_PATH)
check('probe route is namespaced', PROBE_PATH.startsWith('/__dsh-desktop-bridge/'), PROBE_PATH)
check('health route is namespaced', HEALTH_PATH.startsWith('/__dsh-desktop-bridge/'), HEALTH_PATH)
check('token global is namespaced', TOKEN_GLOBAL === '__DSH_DESKTOP_BRIDGE__', TOKEN_GLOBAL)

console.log('\nevent shape')
const ev = makeEvent({ kind: NOTIFY_KIND.done, sessionId: 'abc', title: 't', detail: 'd', at: 1700000000000 })
check('protocol version stamped', ev.v === PROTOCOL_VERSION, String(ev.v))
check('dedupe key is stable per second', ev.dedupeKey === 'done:abc:1700000000', ev.dedupeKey)
check('isMain is left undefined when unstated', ev.isMain === undefined, String(ev.isMain))
check('isMain survives as false', makeEvent({ kind: 'done', sessionId: 'a', isMain: false }).isMain === false)
check('isMain survives as true', makeEvent({ kind: 'done', sessionId: 'a', isMain: true }).isMain === true)

console.log('\nfailure kind')
check('failed is a first-class kind', NOTIFY_KIND.failed === 'failed', NOTIFY_KIND.failed)
check('every kind validates', NOTIFY_KINDS.every((k) => validateEvent(makeEvent({ kind: k, sessionId: 'a' })) === null))
const failed = makeEvent({ kind: 'failed', sessionId: 'abc', detail: 'boom', at: 1700000000000 })
check('failed events normalise like any other kind', failed !== null && failed.kind === 'failed', String(failed))
check('failed has its own dedupe namespace', failed.dedupeKey === 'failed:abc:1700000000', failed.dedupeKey)
check('an unknown kind is still rejected', makeEvent({ kind: 'nope', sessionId: 'a' }) === null)

console.log(failures === 0 ? '\nall checks passed' : `\n${failures} check(s) failed`)
process.exit(failures === 0 ? 0 : 1)
