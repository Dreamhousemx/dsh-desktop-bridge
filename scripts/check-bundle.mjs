// Assert the client bundle is a classic script. The browser loads
// /plugins/<pkg>/client.js with a plain <script> tag, so any top-level
// `import`/`export` is a hard SyntaxError that aborts the whole web boot —
// exactly the failure recorded in crash-2026-10-17T04-04-31-779Z-web-boot.log.
import fs from 'node:fs'

const source = fs.readFileSync(new URL('../lib/client.js', import.meta.url), 'utf8')

let failures = 0
const check = (label, ok, detail = '') => {
  console.log(`${ok ? '  ok  ' : '  FAIL'} ${label}${detail ? ` — ${detail}` : ''}`)
  if (!ok) failures += 1
}

try {
  // Parses without executing, so `window` being undefined does not matter.
  new Function(source)
  check('parses as a classic script', true)
} catch (error) {
  check('parses as a classic script', false, error.message)
}

const esmTokens = [...source.matchAll(/^\s*(?:import|export)\s/gm)]
check('no top-level import/export tokens', esmTokens.length === 0, `${esmTokens.length} found`)

const requires = [...new Set([...source.matchAll(/require\(\s*['"]([^'"]+)['"]\s*\)/g)].map((m) => m[1]))]
check('only baseline modules are required', requires.every((id) => id === 'react' || id === 'react/jsx-runtime'), requires.join(', ') || 'none')

const id = source.match(/id:\s*["']([^"']+)["']/)
const pkg = JSON.parse(fs.readFileSync(new URL('../package.json', import.meta.url), 'utf8'))
check('envelope id matches the package name', id?.[1] === pkg.name, id?.[1])

check('envelope closes with the factory return', source.trimEnd().endsWith('});'))

console.log(failures === 0 ? '\nclassic-script contract satisfied\n' : `\n${failures} check(s) failed\n`)
process.exit(failures === 0 ? 0 : 1)
