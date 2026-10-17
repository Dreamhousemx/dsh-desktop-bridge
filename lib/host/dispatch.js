/**
 * Notification dispatch: turns bridge events into toasts, applying the
 * noise-control rules that keep this feature useful instead of annoying.
 *
 * Rules, in order:
 *  1. Dedupe      - a reconnecting SSE stream replays nothing, but a restarted
 *                   plugin might resend. The dedupe key is stable per event.
 *  2. Quiet hours - suppress entirely.
 *  3. Focus gate  - opt-in, and scoped to the session you are looking at: suppress
 *                   'done' only when that session is the one in the main view AND
 *                   the DSH window is foreground. 'waiting' toasts are never
 *                   focus-gated: a blocked session deserves a nudge even if you
 *                   happen to have DSH focused but scrolled away.
 *                   Off by default — a finished turn draws no attention to itself
 *                   in the page, which is the whole reason this plugin exists.
 *  4. Throttle    - per-kind minimum gap, so a burst of finishing sessions
 *                   produces one toast plus a summary rather than five toasts.
 */

import { sendToast } from './toast.js';
import { isQuietHours, log } from './state.js';
import { isDshForeground } from './activate.js';
import { ensureAumid } from './aumid.js';
import { NOTIFY_KIND } from './protocol.js';

const DEDUPE_MAX = 200;

export class Dispatcher {
  constructor(settings) {
    this.settings = settings;
    this.seen = []; // FIFO of dedupe keys
    this.seenSet = new Set();
    this.lastToastAt = { [NOTIFY_KIND.waiting]: 0, [NOTIFY_KIND.done]: 0 };
    /**
     * Events held back by the throttle, to be summarised into one toast.
     * @type {Map<string, {kind: string, title: string}>}
     */
    this.deferred = new Map();
    this.flushTimer = null;
  }

  /** Returns true when this event was already handled. */
  #isDuplicate(key) {
    if (!key) return false;
    if (this.seenSet.has(key)) return true;
    this.seen.push(key);
    this.seenSet.add(key);
    if (this.seen.length > DEDUPE_MAX) {
      const evicted = this.seen.shift();
      this.seenSet.delete(evicted);
    }
    return false;
  }

  /** Human-facing copy for each kind. */
  #compose(ev) {
    const title = ev.title ? `「${ev.title}」` : '当前会话';
    if (ev.kind === NOTIFY_KIND.waiting) {
      return {
        title: '需要你确认',
        body: `${title} 正在等待你的操作${ev.detail ? `：${ev.detail}` : ''}`,
        tag: `waiting-${ev.sessionId}`,
      };
    }
    return {
      title: '任务已完成',
      body: `${title} 已执行完毕${ev.detail ? `：${ev.detail}` : ''}`,
      tag: `done-${ev.sessionId}`,
    };
  }

  /**
   * Handles one validated bridge event.
   * @returns {Promise<'shown'|'duplicate'|'quiet'|'focused'|'throttled'>}
   */
  async handle(ev) {
    if (this.#isDuplicate(ev.dedupeKey)) {
      log('dispatch: duplicate event ignored:', ev.dedupeKey);
      return 'duplicate';
    }

    if (isQuietHours(this.settings)) {
      log('dispatch: suppressed (quiet hours):', ev.kind, ev.title);
      return 'quiet';
    }

    // Only 'done' is focus-gated, and only for the session that is actually on
    // screen; see the rule list at the top of this file.
    if (this.settings.suppressWhenFocused && ev.kind === NOTIFY_KIND.done && ev.isMain !== false) {
      const focused = await isDshForeground();
      if (focused === true) {
        log('dispatch: suppressed (that session is on screen and DSH is focused):', ev.title);
        return 'focused';
      }
    }

    const now = Date.now();
    const last = this.lastToastAt[ev.kind] ?? 0;
    const gap = now - last;
    if (gap < this.settings.throttleMs) {
      log(
        `dispatch: throttled (${gap}ms < ${this.settings.throttleMs}ms), deferring:`,
        ev.kind,
        ev.title,
      );
      this.deferred.set(ev.sessionId, { kind: ev.kind, title: ev.title });
      this.#scheduleFlush();
      return 'throttled';
    }

    await this.#show(ev);
    this.lastToastAt[ev.kind] = Date.now();
    return 'shown';
  }

  async #show(ev) {
    const copy = this.#compose(ev);
    // Windows needs the AUMID registered before the first toast can carry our
    // name; doing it here keeps startup free of registry work.
    await ensureAumid();
    await sendToast({
      ...copy,
      group: 'dsh-notify',
      attribution: 'DeepSeek Harness',
    });
  }

  /** Collapses everything held back by the throttle into a single summary toast. */
  #scheduleFlush() {
    if (this.flushTimer) return;
    this.flushTimer = setTimeout(() => {
      this.flushTimer = null;
      void this.flushDeferred();
    }, this.settings.throttleMs);
  }

  async flushDeferred() {
    if (this.deferred.size === 0) return;
    const items = [...this.deferred.values()];
    this.deferred.clear();
    if (isQuietHours(this.settings)) return;

    const waiting = items.filter((i) => i.kind === NOTIFY_KIND.waiting);
    const done = items.filter((i) => i.kind === NOTIFY_KIND.done);

    // A pending confirmation outranks a completion summary: it is blocking work.
    const parts = [];
    if (waiting.length) parts.push(`${waiting.length} 个等待确认`);
    if (done.length) parts.push(`${done.length} 个已完成`);

    if (parts.length === 0) return;

    const names = items
      .map((i) => i.title)
      .filter(Boolean)
      .slice(0, 3)
      .join('、');

    await ensureAumid();
    await sendToast({
      title: waiting.length ? '还有任务需要你处理' : '更多任务已完成',
      body: `${parts.join('，')}${names ? `：${names}` : ''}`,
      tag: 'deferred-summary',
      group: 'dsh-notify',
      attribution: 'DeepSeek Harness',
      silent: waiting.length === 0,
    });
    log(`dispatch: flushed ${items.length} deferred events as one summary`);
  }

  dispose() {
    if (this.flushTimer) {
      clearTimeout(this.flushTimer);
      this.flushTimer = null;
    }
  }
}
