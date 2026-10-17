// Post-change verification for the desktop profile wiring.
//
// Checks the things that must all be true for `dsh-desktop-bridge` to load, and
// the things the crash-recovery button silently removed.
import fs from 'node:fs'
import path from 'node:path'
import { createRequire } from 'node:module'

const dir = 'C:/Users/mfy_c/.dsh/profiles/desktop'
const require = createRequire(path.join(dir, 'noop.cjs'))
const YAML = require('yaml')

let failures = 0
const check = (label, ok, detail = '') => {
  console.log(`${ok ? '  ok  ' : '  FAIL'} ${label}${detail ? ` — ${detail}` : ''}`)
  if (!ok) failures += 1
}

const pkg = JSON.parse(fs.readFileSync(path.join(dir, 'package.json'), 'utf8'))
const patch = YAML.parse(fs.readFileSync(path.join(dir, 'cordis.patch.yml'), 'utf8'))

console.log('\nprofile: package.json')
check('bridge in dependencies', Boolean(pkg.dependencies['dsh-desktop-bridge']), pkg.dependencies['dsh-desktop-bridge'])
check('bridge in dsh.profile.bundles', pkg.dsh.profile.bundles.includes('dsh-desktop-bridge'))
check('no dsh-task-notifier leftovers', !pkg.dsh.profile.bundles.includes('dsh-task-notifier') && !pkg.dependencies['dsh-task-notifier'])

console.log('\nprofile: cordis.patch.yml')
const ids = patch.map((e) => (e.insert ? 'insert' : e.id))
check('patch parses as a top-level array', Array.isArray(patch), `${patch.length} entries`)
check('bridge insert present', patch.some((e) => e.insert?.some((i) => i.id === 'dsh-desktop-bridge')))

// The entries the crash-recovery button dropped; each owns real user settings.
for (const id of ['permission', 'ui-theme', 'ui-conversation', 'agency-agents', 'better-sidebar', 'llm-pi-ai', 'ui-usage-billing']) {
  check(`restored ${id}`, ids.includes(id))
}
check('permission presets intact', Boolean(patch.find((e) => e.id === 'permission')?.config?.presets))
check('danger-full-access still the default preset', patch.find((e) => e.id === 'permission')?.config?.defaultPreset === 'danger-full-access')

console.log('\nlink')
const link = path.join(dir, 'node_modules', 'dsh-desktop-bridge')
check('node_modules link exists', fs.existsSync(link))
const entry = path.join(link, 'lib', 'client.js')
check('client bundle reachable through the link', fs.existsSync(entry))

if (fs.existsSync(entry)) {
  const source = fs.readFileSync(entry, 'utf8')
  check('bundle carries the module loader envelope', /window\.__ModuleLoader__\.load\(\{/.test(source))
  // The loader keys the factory by package name; a mismatch means the shell
  // looks up an id that never registers.
  const pkgJson = JSON.parse(fs.readFileSync(path.join(link, 'package.json'), 'utf8'))
  check('envelope id matches the package name', source.includes(`id: "${pkgJson.name}"`) || source.includes(`id:"${pkgJson.name}"`), pkgJson.name)
}

console.log(failures === 0 ? '\nall checks passed\n' : `\n${failures} check(s) failed\n`)
process.exit(failures === 0 ? 0 : 1)
