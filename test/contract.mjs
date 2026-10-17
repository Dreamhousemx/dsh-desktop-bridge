/**
 * Contract test for the browser half.
 *
 * Guards the two failures that actually took DSH down, so neither can come back:
 *
 *  1. **Bundle format.** `lib/client.js` is served as a classic script inside
 *     `window.__ModuleLoader__.load({...})`. A stray top-level `export` makes the
 *     renderer throw `Uncaught SyntaxError: Unexpected token 'export'`, which
 *     fails the whole web boot ("web boot: 1 entry did not activate").
 *  2. **Inject completeness.** cordis proxies `ctx.<name>` off the exported
 *     `inject` array and throws `cannot get property "<name>" without inject` for
 *     anything missing. Because the reads happen inside a lazy callback, that
 *     only surfaces on first use, not at `apply()` time.
 *
 * The ctx here deliberately throws like cordis does. A mock that hands back
 * whatever the plugin asks for would have hidden both bugs.
 *
 * Run: node test/contract.mjs
 */

import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import vm from 'node:vm'

const here = dirname(fileURLToPath(import.meta.url))
const clientPath = join(here, '..', 'lib', 'client.js')
const pkgPath = join(here, '..', 'package.json')

const source = readFileSync(clientPath, 'utf8')
const pkg = JSON.parse(readFileSync(pkgPath, 'utf8'))

let passed = 0
const check = (label, fn) => {
  fn()
  passed += 1
  console.log(`  ok  ${label}`)
}

// ---------------------------------------------------------------------------
// Guard: the format check below must actually reject ESM. If this assertion
// ever stops throwing, every later "ok" is meaningless.
// ---------------------------------------------------------------------------
{
  const sandbox = { window: { __ModuleLoader__: { load() {} } }, console }
  assert.throws(
    () => vm.runInNewContext('export const x = 1', sandbox, { filename: 'probe.js' }),
    /Unexpected token 'export'/,
    'the ESM rejection probe itself must throw',
  )
}

// ---------------------------------------------------------------------------
// 1. Bundle format
// ---------------------------------------------------------------------------
let registered = null
const sandbox = {
  console: { warn() {}, log() {}, error() {} },
  Object,
  Symbol,
  Map,
  Set,
  Date,
  String,
  Boolean,
  JSON,
  Array,
  Error,
  __DSH_DESKTOP_BRIDGE__: { token: 'test-token-000000000000000000000000000000', protocol: 1 },
}
sandbox.globalThis = sandbox
sandbox.window = {
  __ModuleLoader__: {
    load(entry) {
      registered = entry
    },
  },
}
// A stub so the classic-script evaluation cannot touch the network or React.
sandbox.fetch = () => Promise.resolve({ ok: true, status: 200 })

console.log(`\nbundle: ${clientPath}`)

check('parses as a classic script (no top-level import/export)', () => {
  vm.runInNewContext(source, sandbox, { filename: 'client.js' })
})

check('registers exactly one module', () => {
  assert.ok(registered, 'window.__ModuleLoader__.load was never called')
})

check(`module id equals the package name (${pkg.name})`, () => {
  assert.equal(registered.id, pkg.name, 'the loader resolves bundles by id; a mismatch leaves the module unfindable')
})

// ---------------------------------------------------------------------------
// 2. Exports
// ---------------------------------------------------------------------------
const fakeRequire = (spec) => {
  throw new Error(`unexpected require(${spec}) — this bundle must stay dependency-free`)
}

let mod = null

check('factory returns an export object', () => {
  mod = registered.factory(fakeRequire)
  assert.equal(typeof mod, 'object')
})

check('exposes apply / inject', () => {
  assert.equal(typeof mod.apply, 'function')
  assert.ok(Array.isArray(mod.inject), 'inject must be an array')
})

// ---------------------------------------------------------------------------
// 3. Inject completeness — the ctx throws for anything undeclared.
// ---------------------------------------------------------------------------
check('every ctx.<service> read is declared in inject', () => {
  const declared = new Set(mod.inject)
  // Core context members provided by cordis itself, never listed in `inject`.
  const CORE = new Set(['effect', 'on', 'off', 'emit', 'get', 'set', 'inject', 'logger', 'root', 'scope'])
  const seenNames = new Set()
  for (const m of source.matchAll(/\bctx\.([A-Za-z_$][\w$]*)/g)) seenNames.add(m[1])
  for (const m of source.matchAll(/\bctx\[['"]([\w$]+)['"]\]/g)) seenNames.add(m[1])
  const missing = [...seenNames].filter((n) => !declared.has(n) && !CORE.has(n))
  assert.deepEqual(missing, [], `undeclared service reads: ${missing.join(', ')}`)
})

// ---------------------------------------------------------------------------
// 4. Behaviour — drive real transitions through a cordis-faithful ctx.
// ---------------------------------------------------------------------------
const posted = []

function makeCtx({ withToken = true } = {}) {
  const declared = new Set(mod.inject)
  let snapshot = new Map()
  const listeners = new Set()

  const sessionStatus = {
    getSnapshot: () => snapshot,
    subscribe: (fn) => {
      listeners.add(fn)
      return () => listeners.delete(fn)
    },
  }

  const list = {
    getSnapshot: () => ({ phase: 'ready', ids: ['s1'], byId: { s1: { title: '重构登录模块' } } }),
  }

  const services = {
    uiSession: { sessionStatus },
    sessions: { list },
  }

  const target = {
    effect: (fn) => fn(),
  }

  const ctx = new Proxy(target, {
    get(t, prop) {
      if (prop in t) return t[prop]
      if (prop === 'then') return undefined
      if (typeof prop !== 'string') return undefined
      if (!declared.has(prop)) {
        throw new Error(`cannot get property "${prop}" without inject`)
      }
      return services[prop]
    },
  })

  return {
    ctx,
    publish(next) {
      snapshot = next
      for (const fn of listeners) fn()
    },
  }
}

sandbox.fetch = (url, init) => {
  posted.push({ url, init })
  return Promise.resolve({ ok: true, status: 200 })
}

console.log('\nbehaviour')

check('first sighting is silent (a page load must not replay history)', async () => {
  const { ctx, publish } = makeCtx()
  mod.apply(ctx)
  publish(new Map([['s1', { running: true, pendingInteraction: { kind: 'approval' }, completionUnread: false }]]))
  assert.equal(posted.length, 0, 'baseline snapshot must not notify')
})

check('entering a pending interaction posts exactly one waiting event', () => {
  const { ctx, publish } = makeCtx()
  posted.length = 0
  mod.apply(ctx)
  publish(new Map([['s1', { running: true, pendingInteraction: undefined, completionUnread: false }]]))
  publish(new Map([['s1', { running: true, pendingInteraction: { kind: 'plan-review' }, completionUnread: false }]]))

  assert.equal(posted.length, 1, 'expected exactly one ingest call')
  const { url, init } = posted[0]
  assert.equal(url, '/__dsh-desktop-bridge/ingest', 'must stay same-origin')
  assert.equal(init.method, 'POST')
  assert.match(init.headers.authorization, /^Bearer test-token/, 'token must ride in the Authorization header')
  const body = JSON.parse(init.body)
  assert.equal(body.kind, 'waiting')
  assert.equal(body.sessionId, 's1')
  assert.equal(body.title, '重构登录模块')
  assert.equal(body.detail, '等待你确认计划')
})

check('waiting again in the same snapshot does not re-post', () => {
  const { ctx, publish } = makeCtx()
  posted.length = 0
  mod.apply(ctx)
  publish(new Map([['s1', { running: true, pendingInteraction: undefined, completionUnread: false }]]))
  const waiting = new Map([['s1', { running: true, pendingInteraction: { kind: 'approval' }, completionUnread: false }]])
  publish(waiting)
  publish(waiting)
  publish(waiting)
  assert.equal(posted.length, 1, 'repeated publications of one pending state must not stack toasts')
})

check('running -> idle posts done', () => {
  const { ctx, publish } = makeCtx()
  posted.length = 0
  mod.apply(ctx)
  publish(new Map([['s1', { running: true, pendingInteraction: undefined, completionUnread: false }]]))
  publish(new Map([['s1', { running: false, pendingInteraction: undefined, completionUnread: false }]]))

  assert.equal(posted.length, 1)
  const body = JSON.parse(posted[0].init.body)
  assert.equal(body.kind, 'done')
  assert.equal(body.detail, '任务已完成')
})

check('an unknown pending kind still names the session', () => {
  const { ctx, publish } = makeCtx()
  posted.length = 0
  mod.apply(ctx)
  publish(new Map([['s1', { running: true, pendingInteraction: undefined, completionUnread: false }]]))
  publish(new Map([['s1', { running: true, pendingInteraction: { kind: 'something-new' }, completionUnread: false }]]))
  const body = JSON.parse(posted[0].init.body)
  assert.equal(body.detail, '等待你处理')
})

// ---------------------------------------------------------------------------
// Summary
// ---------------------------------------------------------------------------
console.log(`\n${passed} checks passed\n`)
