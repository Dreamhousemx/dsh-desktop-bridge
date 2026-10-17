/**
 * Toast sending for dsh-desktop-notifier.
 *
 * Sends Windows toast notifications through Windows PowerShell 5.1 + WinRT.
 * PowerShell 7 cannot load the WinRT projections, so POWERSHELL_51 is a hard
 * requirement rather than a preference.
 *
 * Design notes:
 *  - The toast XML is built here in JS and passed to PowerShell as a
 *    base64-encoded string. That avoids every quoting/escaping hazard between
 *    our strings, the PowerShell command line, and the XML document, and keeps
 *    user-supplied text (session titles) from being interpreted as markup.
 *  - Toasts go through a reusable PowerShell process pool rather than one
 *    process per toast: each cold PowerShell start costs 200-500ms, which is
 *    noticeable when several sessions finish at once.
 */

import { spawn } from 'node:child_process';
import { POWERSHELL_51, AUMID } from './constants.js';
import { log } from './state.js';

/** Escapes text for inclusion in XML character data. */
export function escapeXml(text) {
  return String(text ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

/**
 * Builds the toast XML document.
 *
 * @param {object} opts
 * @param {string} opts.title      bold first line
 * @param {string} opts.body       second line
 * @param {string} [opts.tag]      dedupe/replace key within the app's notifications
 * @param {string} [opts.group]    grouping key, so we can clear our toasts only
 * @param {boolean} [opts.silent]  suppress the sound
 * @param {string} [opts.attribution] small footer text, e.g. the session name
 */
export function buildToastXml({ title, body, tag, group, silent = false, attribution }) {
  const textNodes = [
    `<text>${escapeXml(title)}</text>`,
    `<text>${escapeXml(body)}</text>`,
  ];
  if (attribution) {
    textNodes.push(`<text placement="attribution">${escapeXml(attribution)}</text>`);
  }

  const attrs = ['activationType="foreground"'];
  if (tag) attrs.push(`tag="${escapeXml(tag)}"`);
  if (group) attrs.push(`group="${escapeXml(group)}"`);

  const audio = silent
    ? '<audio silent="true"/>'
    : '<audio src="ms-winsoundevent:Notification.Default"/>';

  return `<?xml version="1.0" encoding="utf-8"?>
<toast ${attrs.join(' ')}>
  <visual>
    <binding template="ToastGeneric">
      ${textNodes.join('\n      ')}
    </binding>
  </visual>
  ${audio}
</toast>`.trim();
}

/**
 * A long-lived PowerShell 5.1 process that reads lines from stdin. Each line is
 * a base64-encoded toast XML; each line produces one toast.
 *
 * If the process dies it is respawned on the next send. A single failed toast is
 * logged and dropped rather than retried, so a broken shell never turns into a
 * toast storm.
 */
class ToastWorker {
  constructor() {
    this.proc = null;
    this.ready = false;
    this.pending = [];
    this.restarts = 0;
    this.startScript = `
$ErrorActionPreference = 'Stop'
[Windows.UI.Notifications.ToastNotificationManager, Windows.UI.Notifications, ContentType = WindowsRuntime] | Out-Null
[Windows.Data.Xml.Dom.XmlDocument, Windows.Data.Xml.Dom, ContentType = WindowsRuntime] | Out-Null
$notifier = [Windows.UI.Notifications.ToastNotificationManager]::CreateToastNotifier('${AUMID}')
[Console]::Out.WriteLine('READY')
[Console]::Out.Flush()
while ($true) {
  $line = [Console]::In.ReadLine()
  if ($null -eq $line) { break }
  if ([string]::IsNullOrWhiteSpace($line)) { continue }
  try {
    $xmlText = [System.Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($line))
    $xml = New-Object Windows.Data.Xml.Dom.XmlDocument
    $xml.LoadXml($xmlText)
    $toast = [Windows.UI.Notifications.ToastNotification]::new($xml)
    $notifier.Show($toast)
    [Console]::Out.WriteLine('OK')
  } catch {
    [Console]::Out.WriteLine('ERR ' + $_.Exception.Message)
  }
  [Console]::Out.Flush()
}
`;
  }

  ensureStarted() {
    if (this.proc && !this.proc.killed && this.ready) return true;
    if (this.proc) return false; // still starting

    log('toast worker: spawning powershell');
    const b64Script = Buffer.from(this.startScript, 'utf16le').toString('base64');
    this.proc = spawn(
      POWERSHELL_51,
      ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-EncodedCommand', b64Script],
      { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true },
    );

    let buffer = '';
    this.proc.stdout.setEncoding('utf8');
    this.proc.stdout.on('data', (chunk) => {
      buffer += chunk;
      let idx;
      while ((idx = buffer.indexOf('\n')) !== -1) {
        const line = buffer.slice(0, idx).trim();
        buffer = buffer.slice(idx + 1);
        if (!line) continue;
        if (line === 'READY') {
          this.ready = true;
          log('toast worker: ready');
          while (this.pending.length) this.pending.shift()();
          continue;
        }
        if (line.startsWith('ERR')) log('toast worker: show failed:', line.slice(4));
      }
    });

    this.proc.stderr.setEncoding('utf8');
    this.proc.stderr.on('data', (chunk) => {
      // PowerShell serialises stderr as CLIXML; the "#< CLIXML" header and the
      // <Objs> wrapper carry no information we care about.
      const text = String(chunk)
        .replace(/#<\s*CLIXML\s*/g, ' ')
        .replace(/<Objs[\s\S]*?<\/Objs>/g, ' ')
        .replace(/<\/?S S="[^"]*">/g, ' ')
        .replace(/\s+/g, ' ')
        .trim();
      if (text) log('toast worker stderr:', text);
    });

    this.proc.on('exit', (code, signal) => {
      log(`toast worker: exited code=${code} signal=${signal}`);
      this.proc = null;
      this.ready = false;
    });

    this.proc.on('error', (err) => {
      log('toast worker: spawn error:', err.message);
      this.proc = null;
      this.ready = false;
    });

    return false;
  }

  /** Shows one toast. Resolves once the XML has been handed to PowerShell. */
  async show(xmlText) {
    if (!this.ensureStarted()) {
      // Wait for READY before writing, otherwise the child may not be listening.
      await new Promise((resolve) => this.pending.push(resolve));
    }
    if (!this.proc || !this.proc.stdin.writable) {
      log('toast worker: stdin not writable, dropping toast');
      return false;
    }
    const b64 = Buffer.from(xmlText, 'utf8').toString('base64');
    try {
      this.proc.stdin.write(b64 + '\n');
      return true;
    } catch (err) {
      log('toast worker: write failed:', err.message);
      return false;
    }
  }

  dispose() {
    if (this.proc) {
      try {
        this.proc.stdin.end();
      } catch {
        /* ignore */
      }
      try {
        this.proc.kill();
      } catch {
        /* ignore */
      }
      this.proc = null;
      this.ready = false;
    }
  }
}

const worker = new ToastWorker();

/**
 * Sends a toast.
 *
 * @param {object} opts  see buildToastXml
 * @returns {Promise<boolean>} whether the toast was handed to the shell
 */
export async function sendToast(opts) {
  const xml = buildToastXml(opts);
  log('toast:', opts.title, '|', opts.body);
  return worker.show(xml);
}

export function disposeToasts() {
  worker.dispose();
}

/**
 * Starts the PowerShell toast worker ahead of the first notification.
 *
 * Cold-starting PowerShell 5.1 with the WinRT projections costs 1.0-1.5s. Doing
 * that on the first toast would delay exactly the notification that matters most
 * (a session blocked waiting for confirmation), so warm the pool at startup
 * instead. Failure is logged and otherwise ignored: the next send will retry.
 */
export function warmUpToasts() {
  const started = new Promise((resolve) => {
    if (worker.ready) {
      resolve(true);
      return;
    }
    const t0 = Date.now();
    const poll = setInterval(() => {
      if (worker.ready) {
        clearInterval(poll);
        log(`toast worker: warm-up complete in ${Date.now() - t0}ms`);
        resolve(true);
      } else if (!worker.proc) {
        // ensureStarted spawns; if it bailed there is nothing to wait for.
        clearInterval(poll);
        resolve(false);
      }
    }, 50);
    // Hard ceiling so warm-up can never hold up startup.
    setTimeout(() => {
      clearInterval(poll);
      resolve(worker.ready);
    }, 5000);
    worker.ensureStarted();
  });
  return started;
}
