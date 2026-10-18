/**
 * The ingest route: the browser half's only way in.
 *
 * The renderer cannot call into the host process directly, so events travel over
 * HTTP on the DSH web server that is already running. That keeps the plugin free
 * of extra ports, extra processes, and any discovery file.
 *
 * Security: the route is same-origin from the page's point of view, but "same
 * origin" is not authentication — any local process can POST to 127.0.0.1. So the
 * host mints a per-process token, injects it into index.html, and requires it as
 * a bearer credential. The token dies with the process.
 *
 * Diagnostics matter here: when a notification does not appear, the only useful
 * question is "did the event arrive?". Every arrival and every rejection is
 * logged, and the health counters keep the stages apart.
 */

import { randomBytes, timingSafeEqual } from 'node:crypto'
import { HEALTH_PATH, INGEST_PATH, PROBE_PATH, TOKEN_GLOBAL } from './host/constants.js'
import { NOTIFY_KINDS, makeEvent } from './host/protocol.js'

/** Bodies larger than this are refused rather than buffered. */
const MAX_BODY_BYTES = 64 * 1024

/** Probes are verbose; keep a misbehaving client from filling the log. */
const MAX_PROBES_LOGGED = 400
const MAX_PROBE_TEXT = 900

function safeEqual(a, b) {
  const left = Buffer.from(String(a ?? ''), 'utf8')
  const right = Buffer.from(String(b ?? ''), 'utf8')
  if (left.length !== right.length) return false
  try {
    return timingSafeEqual(left, right)
  } catch {
    return false
  }
}

function bearer(req) {
  const header = req.headers?.authorization
  if (typeof header !== 'string') return ''
  const match = /^Bearer\s+(.+)$/i.exec(header.trim())
  return match ? match[1] : ''
}

function sendJson(res, status, payload) {
  const body = JSON.stringify(payload)
  try {
    res.writeHead(status, {
      'content-type': 'application/json; charset=utf-8',
      'content-length': Buffer.byteLength(body),
      'cache-control': 'no-store',
    })
    res.end(body)
  } catch {
    /* the socket may already be gone */
  }
}

/** Reads and parses the request body, or reports why it could not. */
function readJsonBody(req) {
  return new Promise((resolve) => {
    let size = 0
    const chunks = []
    let done = false
    const finish = (value) => {
      if (done) return
      done = true
      resolve(value)
    }

    req.on('data', (chunk) => {
      size += chunk.length
      if (size > MAX_BODY_BYTES) {
        finish({ error: 'body too large' })
        return
      }
      chunks.push(chunk)
    })
    req.on('end', () => {
      if (size === 0) {
        finish({ value: undefined })
        return
      }
      try {
        finish({ value: JSON.parse(Buffer.concat(chunks).toString('utf8')) })
      } catch {
        finish({ error: 'invalid json' })
      }
    })
    req.on('error', () => finish({ error: 'read failed' }))
  })
}

/** Short id for logs — a full session id is noise in a log line. */
const short = (id) => String(id ?? '').slice(0, 8)

/**
 * Creates the route handlers.
 *
 * @param {object} opts
 * @param {(ev: object) => Promise<string>} opts.handleEvent
 * @param {(msg: string) => void} opts.log
 * @param {() => object} [opts.stats] counters owned by the notifier
 */
export function createIngest({ handleEvent, log, stats }) {
  const token = randomBytes(24).toString('hex')
  const counters = { unauthorized: 0, invalid: 0, probes: 0 }

  const healthPayload = () => ({
    ok: true,
    protocol: 1,
    // Which kinds this process actually accepts. A restart is the only thing that
    // swaps the host half, so "is the running host newer than my page?" is a real
    // question — and without an answer here it can only be guessed at. It also
    // makes a stale host visible to the client, which then stays quiet instead of
    // posting an event that would be dropped as malformed.
    kinds: NOTIFY_KINDS,
    ...(stats ? stats() : {}),
    ...counters,
  })

  const handleHealth = (req, res) => {
    sendJson(res, 200, healthPayload())
  }

  /** Rejects a request that did not authenticate, and says so in the log. */
  const deny = (req, res, where) => {
    counters.unauthorized += 1
    log(`auth: ${where} rejected — token mismatch (${counters.unauthorized} so far)`)
    sendJson(res, 401, { ok: false, error: 'unauthorized' })
  }

  const handleIngest = async (req, res) => {
    if (req.method !== 'POST') {
      sendJson(res, 405, { ok: false, error: 'method not allowed' })
      return
    }
    if (!safeEqual(bearer(req), token)) {
      deny(req, res, 'POST /ingest')
      return
    }

    const body = await readJsonBody(req)
    if (body.error) {
      log(`ingest: ${body.error}`)
      sendJson(res, 400, { ok: false, error: body.error })
      return
    }

    const raw = body.value
    const incoming = Array.isArray(raw) ? raw : [raw]
    if (incoming.length === 0) {
      sendJson(res, 202, { ok: true, accepted: 0 })
      return
    }

    const results = []
    for (const item of incoming.slice(0, 20)) {
      // Normalising here means the browser half only has to send the plain fields
      // and cannot hand us a dedupeKey that disagrees with this process.
      const ev = makeEvent(item ?? {})
      if (!ev) {
        counters.invalid += 1
        log(`ingest: dropped malformed event ${JSON.stringify(item).slice(0, 200)}`)
        results.push('invalid')
        continue
      }

      log(`ingest: ${ev.kind} "${ev.title}" session=${short(ev.sessionId)}`)

      try {
        const result = await handleEvent(ev)
        // Log the verdict, not just the arrival: 'shown' vs 'duplicate' vs
        // 'focused' is the whole difference between a bug and the settings
        // doing their job.
        log(`dispatch: ${result} — ${ev.kind} "${ev.title}"`)
        results.push(result)
      } catch (err) {
        log('ingest: handler failed:', err?.message ?? err)
        results.push('error')
      }
    }

    sendJson(res, 202, { ok: true, results })
  }

  /**
   * Diagnostic sink. The browser half POSTs a compact snapshot of what it observed
   * on every sessionStatus publication. This answers "is the renderer even seeing
   * the transition?" without attaching DevTools.
   */
  const handleProbe = async (req, res) => {
    if (req.method !== 'POST') {
      sendJson(res, 405, { ok: false, error: 'method not allowed' })
      return
    }
    if (!safeEqual(bearer(req), token)) {
      deny(req, res, 'POST /probe')
      return
    }

    counters.probes += 1
    const body = await readJsonBody(req)
    if (counters.probes <= MAX_PROBES_LOGGED && !body.error && body.value !== undefined) {
      log(`probe: ${JSON.stringify(body.value).slice(0, MAX_PROBE_TEXT)}`)
    }
    sendJson(res, 202, { ok: true, logged: !body.error && counters.probes <= MAX_PROBES_LOGGED })
  }

  return {
    token,
    handleIngest,
    handleHealth,
    handleProbe,
    counters,
    TOKEN_GLOBAL,
    INGEST_PATH,
    PROBE_PATH,
    HEALTH_PATH,
  }
}
