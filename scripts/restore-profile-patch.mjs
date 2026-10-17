// Rebuild the profile patch from the pre-crash backup, keeping the model
// selection that DSH wrote after the crash. Run once; leaves a .restore.tmp
// for review before it is moved into place.
import fs from 'node:fs'
import path from 'node:path'
import { createRequire } from 'node:module'

const dir = 'C:/Users/mfy_c/.dsh/profiles/desktop'
const require = createRequire(path.join(dir, 'noop.cjs'))
const YAML = require('yaml')

const backupPath = path.join(dir, 'cordis.patch.yml.bak-1792209582494')
const currentPath = path.join(dir, 'cordis.patch.yml')

const raw = fs.readFileSync(backupPath, 'utf8')
const current = YAML.parse(fs.readFileSync(currentPath, 'utf8'))

const curModel = current.find((e) => e && e.id === 'agent-default-model')?.config
if (!curModel) throw new Error('current patch has no agent-default-model entry')

const block = [
  '- id: agent-default-model',
  '  name: "@deepseek-ai/dsh-agent-default-model"',
  '  config:',
  '    provider: workbuddy-global',
  '    model: deepseek-v4.1-flash',
  '',
].join('\n')

const replacement = [
  '- id: agent-default-model',
  '  name: "@deepseek-ai/dsh-agent-default-model"',
  '  config:',
  `    provider: ${curModel.provider}`,
  `    model: ${curModel.model}`,
  `    reasoningEffort: ${curModel.reasoningEffort ?? 'high'}`,
  '',
].join('\n')

if (!raw.includes(block)) throw new Error('anchor block not found in backup')

const out = raw.replace(block, replacement)
const parsed = YAML.parse(out)

console.log('entries:', parsed.length)
console.log('ids:', parsed.map((e) => (e.insert ? `insert[${e.insert.map((i) => i.id)}]` : e.id)).join(', '))

const model = parsed.find((e) => e && e.id === 'agent-default-model').config
console.log('model config:', JSON.stringify(model))

const permission = parsed.find((e) => e && e.id === 'permission')
console.log('permission presets restored:', Boolean(permission?.config?.presets))
console.log('defaultPreset:', permission?.config?.defaultPreset)
console.log('bridge insert present:', parsed.some((e) => e.insert?.some((i) => i.id === 'dsh-desktop-bridge')))

fs.writeFileSync(path.join(dir, 'cordis.patch.yml.restore.tmp'), out, 'utf8')
console.log('\nwrote cordis.patch.yml.restore.tmp')
