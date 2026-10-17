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
 */

import { randomBytes, timingSafeEqual } from 'node:crypto'
import { HEALTH_PATH, INGEST_PATH, TOKEN_GLOBAL } from './host/constants.js'
import { makeEvent } from './host/protocol.js'

/** Bodies larger than this are refused rather than buffered. */
const MAX_BODY_BYTES = 64 * 1024

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

/** Reads and parses the request body, or returns an error string. */
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

/**
 * Creates the route handlers.
 *
 * @param {object} opts
 * @param {(ev: object) => Promise<string>} opts.handleEvent
 * @param {(msg: string, err?: unknown) => void} opts.log
 * @param {() => number} [opts.stats]
 */
export function createIngest({ handleEvent, log, stats }) {
  const token = randomBytes(24).toString('hex')

  const handleHealth = (req, res) => {
    sendJson(res, 200, { ok: true, protocol: 1, ...(stats ? stats() : {}) })
  }

  const handleIngest = async (req, res) => {
    if (req.method !== 'POST') {
      sendJson(res, 405, { ok: false, error: 'method not allowed' })
      return
    }
    if (!safeEqual(bearer(req), token)) {
      sendJson(res, 401, { ok: false, error: 'unauthorized' })
      return
    }

    const body = await readJsonBody(req)
    if (body.error) {
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
      // Normalising here means the browser half only ever has to send
      // { kind, sessionId, title, detail, at } and cannot inject a v/dedupeKey
      // that disagrees with this process's protocol.
      const ev = makeEvent(item ?? {})
      if (!ev) {
        results.push('invalid')
        continue
      }
      try {
        results.push(await handleEvent(ev))
      } catch (err) {
        log('ingest: handler failed:', err?.message ?? err)
        results.push('error')
      }
    }

    sendJson(res, 202, { ok: true, results })
  }

  return { token, handleIngest, handleHealth, TOKEN_GLOBAL, INGEST_PATH, HEALTH_PATH }
}
