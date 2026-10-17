/**
 * Manual AUMID maintenance.
 *
 * The plugin registers the AUMID itself before its first toast, so running this
 * is normally unnecessary. It is here for the two cases that need a hand:
 *
 *   --check    is the registration intact? (a Windows reset can wipe HKCU classes)
 *   --remove   undo the registration, e.g. before uninstalling the plugin
 *
 * Usage: node scripts/register-aumid.mjs [--check|--remove]
 */

import { AUMID, DISPLAY_NAME } from '../lib/host/constants.js'
import { isAumidRegistered, registerAumid, unregisterAumid } from '../lib/host/aumid.js'

const flag = process.argv[2] ?? ''

if (flag === '--check') {
  const ok = await isAumidRegistered()
  console.log(`${ok ? 'registered' : 'NOT registered'}: ${AUMID} (${DISPLAY_NAME})`)
  process.exit(ok ? 0 : 1)
}

if (flag === '--remove') {
  const removed = await unregisterAumid()
  console.log(`${removed ? 'removed' : 'was not registered'}: ${AUMID}`)
  process.exit(0)
}

if (flag !== '') {
  console.error(`unknown flag ${flag} — expected --check or --remove`)
  process.exit(2)
}

const ok = await registerAumid()
console.log(`${ok ? 'registered' : 'FAILED to register'}: ${AUMID} (${DISPLAY_NAME})`)
process.exit(ok ? 0 : 1)
