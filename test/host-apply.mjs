/**
 * Host-half smoke test.
 *
 * The browser half has its own contract test; this one covers everything that
 * lives in the DSH host process, which the browser test cannot reach:
 *
 *   1. apply() registers exactly the two routes and no discovery machinery
 *   2. the index-inject listener publishes the token global the client reads
 *   3. /ingest rejects an unauthenticated POST
 *   4. an authenticated POST reaches the dispatcher and really sends a toast
 *   5. replaying the same event is deduped
 *
 * Step 4 spawns the real PowerShell toast worker, so a passing run puts one
 * notification on screen — that is deliberate: it proves the merged wiring, not
 * just the individual modules.
 *
 * Run: node test/host-apply.mjs
 */

import assert from 'node:assert/strict'
import { apply, inject, name as pluginName } from '../lib/index.js'

let passed = 0
const check = (label, fn) => {
  fn()
  passed += 1
  console.log(`  ok  ${label}`)
}

// ---------------------------------------------------------------------------
// A ctx shaped like cordis', plus a webServer that records what it is handed.
// ---------------------------------------------------------------------------
const routes = new Map()
const bus = new Map()
let injected = []

const ctx = {
  effect: () => () => {},
  logger: { info() {}, log() {} },
  webServer: {
    register(route) {
      routes.set(route.path, route)
      return () => routes.delete(route.path)
    },
    ctx: {
      on(event, fn) {
        bus.set(event, fn)
      },
      off(event) {
        bus.delete(event)
      },
    },
  },
}

console.log(`\n${pluginName}`)

check('declares the webServer service', () => {
  assert.deepEqual(inject, ['webServer'])
})

const dispose = apply(ctx)

check('registers /ingest, /health and /probe, nothing else', () => {
  assert.deepEqual([...routes.keys()].sort(), [
    '/__dsh-desktop-bridge/health',
    '/__dsh-desktop-bridge/ingest',
    '/__dsh-desktop-bridge/probe',
  ])
})

check('publishes the token global into index.html', () => {
  const listener = bus.get('webserver/index-inject')
  assert.equal(typeof listener, 'function', 'no index-inject listener registered')
  listener(injected)
  const row = injected.find((r) => r.kind === 'global')
  assert.ok(row, 'no global row pushed')
  assert.equal(row.name, '__DSH_DESKTOP_BRIDGE__')
  assert.equal(row.value.protocol, 1)
  assert.deepEqual(row.value.kinds, ['waiting', 'done', 'failed'], 'the page decides what to send from this list')
  assert.match(row.value.token, /^[0-9a-f]{48}$/, 'token must be 24 random bytes in hex')
})

// ---------------------------------------------------------------------------
// A fake req/res pair good enough for the route handlers.
// ---------------------------------------------------------------------------
function request({ method = 'POST', headers = {}, body } = {}) {
  const listeners = new Map()
  const req = {
    method,
    headers,
    on(event, fn) {
      listeners.set(event, fn)
      return req
    },
  }
  const res = {
    status: 0,
    headers: null,
    body: '',
    writeHead(status, headers) {
      res.status = status
      res.headers = headers
    },
    end(chunk) {
      res.body = chunk ?? ''
      res.done?.()
    },
  }
  return {
    req,
    res,
    send() {
      const text = body === undefined ? '' : typeof body === 'string' ? body : JSON.stringify(body)
      const wait = new Promise((resolve) => {
        res.done = resolve
      })
      // Fire on the next tick so the handler has attached its own listeners.
      setImmediate(() => {
        if (text) listeners.get('data')?.(Buffer.from(text))
        listeners.get('end')?.()
      })
      return wait
    },
  }
}

const token = injected.find((r) => r.kind === 'global').value.token

console.log('\nroutes')

// Health is intentionally token-free: it is a liveness probe, not a data door.
{
  const r = request({ method: 'GET' })
  routes.get('/__dsh-desktop-bridge/health').handler(r.req, r.res)
  check('GET /health answers 200 without a token', () => {
    assert.equal(r.res.status, 200)
    const payload = JSON.parse(r.res.body)
    assert.equal(payload.ok, true)
  })
  // The client half can only tell "is the running host newer than my page?" if
  // the host says what it accepts. Without this the answer is a restart-and-hope.
  check('GET /health reports the kinds this host accepts', () => {
    const payload = JSON.parse(r.res.body)
    assert.deepEqual(payload.kinds, ['waiting', 'done', 'failed'])
  })
}

// An unauthenticated ingest must be refused: any local process can reach the port.
{
  const r = request({ headers: {}, body: { kind: 'waiting', sessionId: 's1' } })
  const done = r.send()
  routes.get('/__dsh-desktop-bridge/ingest').handler(r.req, r.res)
  await done
  check('POST /ingest without a token is 401', () => {
    assert.equal(r.res.status, 401)
  })
}

// ---------------------------------------------------------------------------
// The real thing: an authenticated event must reach Windows.
// ---------------------------------------------------------------------------
console.log('\nend to end (this shows two real toasts)')

const event = {
  kind: 'waiting',
  sessionId: 'self-check',
  title: '插件自检',
  detail: '合并后的 host 半边正在发送真实通知',
  at: Date.now(),
}

{
  const r = request({
    headers: { authorization: `Bearer ${token}` },
    body: event,
  })
  const done = r.send()
  routes.get('/__dsh-desktop-bridge/ingest').handler(r.req, r.res)
  await done
  const payload = JSON.parse(r.res.body)
  check('authenticated waiting event is accepted and shown', () => {
    assert.equal(r.res.status, 202)
    assert.deepEqual(payload.results, ['shown'])
  })
}

{
  // Same instant, same session: the dispatcher must recognise the replay.
  const replay = { ...event }
  const r = request({
    headers: { authorization: `Bearer ${token}` },
    body: replay,
  })
  const done = r.send()
  routes.get('/__dsh-desktop-bridge/ingest').handler(r.req, r.res)
  await done
  check('replaying the same event is deduped', () => {
    const payload = JSON.parse(r.res.body)
    assert.deepEqual(payload.results, ['duplicate'])
  })
}

{
  // A failed turn must never be announced with the completion copy.
  const r = request({
    headers: { authorization: `Bearer ${token}` },
    body: {
      kind: 'failed',
      sessionId: 'self-check',
      title: '插件自检',
      detail: 'Error: 401 Authentication failed: API key required',
      at: Date.now(),
    },
  })
  const done = r.send()
  routes.get('/__dsh-desktop-bridge/ingest').handler(r.req, r.res)
  await done
  check('a failed event is accepted and shown as its own kind', () => {
    const payload = JSON.parse(r.res.body)
    assert.equal(r.res.status, 202)
    assert.deepEqual(payload.results, ['shown'])
  })
}

{
  const r = request({ headers: { authorization: `Bearer ${token}` }, body: { kind: 'nope' } })
  const done = r.send()
  routes.get('/__dsh-desktop-bridge/ingest').handler(r.req, r.res)
  await done
  check('a malformed event is reported, not thrown', () => {
    const payload = JSON.parse(r.res.body)
    assert.deepEqual(payload.results, ['invalid'])
  })
}

dispose()

check('dispose unregisters both routes', () => {
  assert.deepEqual([...routes.keys()], [])
})

console.log(`\n${passed} checks passed\n`)
