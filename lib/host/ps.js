/**
 * Asynchronous PowerShell 5.1 bridge.
 *
 * Everything that touches Win32 (toasts, window focus, AUMID registration) goes
 * through Windows PowerShell 5.1: PowerShell 7 cannot load the WinRT or Shell COM
 * projections those calls need.
 *
 * Every helper here is ASYNC on purpose. These run inside the DSH host process,
 * which also owns the GUI event loop, so a synchronous child-process call would
 * freeze the window for the hundreds of milliseconds a PowerShell start costs.
 * Nothing in this feature is worth a stalled UI.
 */

import { spawn } from 'node:child_process'
import { POWERSHELL_51 } from './constants.js'

/**
 * Runs a PowerShell 5.1 script and resolves with its output.
 *
 * Never rejects: a missing or failing PowerShell is a normal condition for this
 * feature (the notification simply does not appear) and must not surface as an
 * unhandled rejection in the host process.
 *
 * @param {string} script
 * @param {{ timeoutMs?: number, env?: Record<string, string> }} [opts]
 * @returns {Promise<{ code: number|null, stdout: string, stderr: string }>}
 */
export function runPowerShell(script, opts = {}) {
  const { timeoutMs = 15000, env } = opts
  return new Promise((resolve) => {
    let settled = false
    const finish = (value) => {
      if (settled) return
      settled = true
      resolve(value)
    }

    let child
    try {
      child = spawn(
        POWERSHELL_51,
        ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', script],
        {
          windowsHide: true,
          stdio: ['ignore', 'pipe', 'pipe'],
          env: env ? { ...process.env, ...env } : process.env,
        },
      )
    } catch (err) {
      finish({ code: null, stdout: '', stderr: String(err?.message ?? err) })
      return
    }

    let stdout = ''
    let stderr = ''
    child.stdout.setEncoding('utf8')
    child.stderr.setEncoding('utf8')
    child.stdout.on('data', (chunk) => {
      stdout += chunk
    })
    child.stderr.on('data', (chunk) => {
      stderr += chunk
    })

    const timer = setTimeout(() => {
      try {
        child.kill()
      } catch {
        /* ignore */
      }
      finish({ code: null, stdout: stdout.trim(), stderr: 'timeout' })
    }, timeoutMs)
    if (typeof timer.unref === 'function') timer.unref()

    child.on('error', (err) => {
      clearTimeout(timer)
      finish({ code: null, stdout: stdout.trim(), stderr: String(err?.message ?? err) })
    })
    child.on('close', (code) => {
      clearTimeout(timer)
      finish({ code, stdout: stdout.trim(), stderr: stderr.trim() })
    })
  })
}

/** Escapes a value for safe embedding inside a single-quoted PowerShell string. */
export function psQuote(value) {
  return String(value).replace(/'/g, "''")
}
