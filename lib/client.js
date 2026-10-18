/**
 * Browser half of `dsh-desktop-bridge`.
 *
 * Watches `uiSession.sessionStatus` — the only place DSH records "this session is
 * waiting on the human" and "this session just finished" — and forwards the
 * transitions to the host half, which serves them to a Windows notifier.
 *
 * It renders nothing: no slot registration, no React tree, no stylesheet, no
 * locale surface. The whole contribution is a subscription plus a same-origin
 * fetch.
 *
 * The signals, and why each needs care:
 *
 *  - `pendingInteraction` is truthy while a session is blocked on the human
 *    (approval / plan review / question). Emit on the rising edge only, or the
 *    user gets a toast storm on every status publication.
 *  - `completionUnread` is set by the host only for sessions that are *not* in
 *    the main view. Reading it alone would miss the common case of a session
 *    finishing while you are looking at it, so a running→idle edge also counts.
 *  - `sessionStatus` cannot tell a clean finish from a failed one: its snapshot
 *    carries exactly {running, pendingInteraction, completionUnread}, so a
 *    running→idle edge alone would report "任务已完成" for a turn that errored.
 *    The verdict therefore comes from `api-session/error`, which the host emits
 *    from `agent/error` — one event per genuinely failed turn, carrying the
 *    error text, and never emitted for a user-initiated stop.
 *
 * Everything is wrapped: this plugin must never be the reason DSH fails to load.
 */
window.__ModuleLoader__.load({
	id: "dsh-desktop-bridge",
	factory: (require) => {
		var module = { exports: {} };
		var exports = module.exports;
		Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });

		/**
		 * Every service read through `ctx` must be declared: cordis proxies
		 * `ctx.<name>` off this list and throws for anything missing ("cannot get
		 * property X without inject").
		 *
		 * `remote` is the client event channel; `api-session/error` arrives on it.
		 */
		const inject = ["sessions", "uiSession", "remote"];

		/** Global the host injects into index.html carrying the bridge token. */
		const TOKEN_GLOBAL = "__DSH_DESKTOP_BRIDGE__";

		const INGEST_PATH = "/__dsh-desktop-bridge/ingest";

		/** Diagnostic sink, only used when the host turns `debug` on. */
		const PROBE_PATH = "/__dsh-desktop-bridge/probe";

		/** Minimum gap between two notifications for the same session and kind. */
		const SAME_KIND_COOLDOWN_MS = 4000;

		/**
		 * How long a recorded failure may still explain a running→idle edge.
		 *
		 * A failed turn emits `api-session/error` and then drops to idle almost
		 * immediately, so the window only has to absorb UI lag. It exists to stop a
		 * failure that had nothing to do with a turn — a background activation
		 * failure, say — from colouring a later, perfectly good completion.
		 */
		const FAILURE_TTL_MS = 120000;

		/** Longest failure text worth putting on a toast. */
		const FAILURE_DETAIL_MAX = 120;

		const LOG = "[desktop-bridge]";

		function warn(msg, err) {
			try {
				console.warn(`${LOG} ${msg}`, err ?? "");
			} catch {
				/* ignore */
			}
		}

		/** Reads the injected bridge config, tolerating its absence. */
		function bridgeConfig() {
			try {
				const cfg = globalThis && globalThis[TOKEN_GLOBAL];
				if (cfg && typeof cfg === "object" && typeof cfg.token === "string") return cfg;
			} catch {
				/* ignore */
			}
			return undefined;
		}

		/** Best-effort human label for a session. */
		function titleOf(listSnapshot, sessionId) {
			const row = listSnapshot && listSnapshot.byId ? listSnapshot.byId[sessionId] : undefined;
			const title = row && typeof row.title === "string" ? row.title.trim() : "";
			if (title) return title;
			const id = String(sessionId ?? "");
			return id ? `会话 ${id.slice(0, 8)}` : "";
		}

		/** Maps a pendingInteraction payload to a short, human verb. */
		function describePending(pending) {
			const kind = pending && typeof pending === "object" ? pending.kind : undefined;
			switch (kind) {
				case "approval":
					return "等待你批准操作";
				case "plan-review":
					return "等待你确认计划";
				case "question":
					return "等待你回答问题";
				default:
					return "等待你处理";
			}
		}

		/**
		 * Turns the `api-session/error` payload into one toast-sized line.
		 *
		 * The host sends a stringified error, which can be a stack trace or an
		 * essay from a provider. Only the first line is useful in a notification,
		 * and only the first ~120 characters survive a toast anyway.
		 */
		function describeFailure(message) {
			const raw = typeof message === "string" ? message : message == null ? "" : String(message);
			const firstLine = raw.split(/\r?\n/).map((line) => line.trim()).find(Boolean) ?? "";
			if (!firstLine) return "本轮执行失败";
			return firstLine.length > FAILURE_DETAIL_MAX ? `${firstLine.slice(0, FAILURE_DETAIL_MAX - 1)}…` : firstLine;
		}

		function apply(ctx) {
			let stopped = false;
			let unsubscribe = null;
			/** Unsubscribes the `api-session/error` listener; separate lifetime from the status feed. */
			let unsubscribeFailure = null;
			/** Per-session last observed state, so only edges emit. */
			const seen = new Map();
			/** Sessions already reported as waiting, to suppress duplicates. */
			const reportedWaiting = new Set();
			/** `kind:sessionId` -> timestamp of the last emission, for cooldown. */
			const lastEmit = new Map();
			/**
			 * sessionId -> the failure that the next running→idle edge should report.
			 *
			 * Written by the `api-session/error` subscription and consumed exactly
			 * once. Cleared when a new turn starts, so a stale record cannot turn a
			 * later clean finish into a fake failure.
			 * @type {Map<string, {at: number, detail: string}>}
			 */
			const failures = new Map();
			let reachedHost = false;
			/** How many events this page has handed to the host, for the probe line. */
			let emitted = 0;

			const statusSource = ctx.uiSession && ctx.uiSession.sessionStatus;

			const listSnapshot = () => {
				try {
					const src = ctx.sessions && ctx.sessions.list;
					return src && typeof src.getSnapshot === "function" ? src.getSnapshot() : undefined;
				} catch {
					return undefined;
				}
			};

			/**
			 * Whether this session is the one filling the main view.
			 *
			 * The host can see the window, but only the page knows which session is
			 * on screen, so the focus gate needs this bit from here.
			 */
			const isMainView = (sessionId) => {
				const snapshot = listSnapshot();
				const row = snapshot && snapshot.byId ? snapshot.byId[sessionId] : undefined;
				return row && row.retainedBy ? (row.retainedBy.mainView ?? 0) > 0 : false;
			};

			/** True when the same session produced the same kind within the cooldown. */
			const throttled = (kind, sessionId) => {
				const key = `${kind}:${sessionId}`;
				const now = Date.now();
				const prev = lastEmit.get(key);
				if (typeof prev === "number" && now - prev < SAME_KIND_COOLDOWN_MS) return true;
				lastEmit.set(key, now);
				return false;
			};

			const send = (kind, sessionId, detail) => {
				const id = String(sessionId ?? "");
				if (!id) return;
				if (throttled(kind, id)) return;

				const cfg = bridgeConfig();
				if (!cfg) {
					if (!reachedHost) warn("bridge token not injected; notifications disabled");
					reachedHost = false;
					return;
				}

				const body = JSON.stringify({
					kind,
					sessionId: id,
					title: titleOf(listSnapshot(), id),
					detail,
					isMain: isMainView(id),
					at: Date.now(),
				});

				emitted += 1;

				try {
					// Same-origin: the host serves this route on DSH's own web server.
					fetch(INGEST_PATH, {
						method: "POST",
						headers: { "content-type": "application/json", authorization: `Bearer ${cfg.token}` },
						body,
						keepalive: true,
					})
						.then((res) => {
							if (!res.ok) throw new Error(`HTTP ${res.status}`);
							reachedHost = true;
						})
						.catch((err) => {
							if (reachedHost) warn("ingest failed", err);
							reachedHost = false;
						});
				} catch (err) {
					// `keepalive` bodies are capped; a very long title could throw synchronously.
					warn("cannot post event", err);
				}
			};

			/**
			 * Posts what this page observed to the host, when the host asked for it.
			 *
			 * This exists because "nothing popped up" is ambiguous from the outside: the
			 * event never left the page, or it left and something downstream dropped it.
			 * One probe line per publication settles that without DevTools.
			 */
			const probe = (snapshot) => {
				const cfg = bridgeConfig();
				if (!cfg || cfg.debug !== true) return;

				const rows = [];
				try {
					snapshot.forEach((state, sessionId) => {
						rows.push([
							String(sessionId ?? "").slice(0, 8),
							state && state.running === true ? 1 : 0,
							state && state.pendingInteraction ? 1 : 0,
							state && state.completionUnread === true ? 1 : 0,
						]);
					});
				} catch {
					return;
				}

				try {
					fetch(PROBE_PATH, {
						method: "POST",
						headers: { "content-type": "application/json", authorization: `Bearer ${cfg.token}` },
						body: JSON.stringify({ at: Date.now(), emitted, rows }),
						keepalive: true,
					}).catch(() => {});
				} catch {
					/* a diagnostic must never break the page */
				}
			};

			/**
			 * Consumes the recorded failure for a session, if it still applies.
			 *
			 * @returns {string|undefined} the failure detail, or undefined for a clean finish.
			 */
			const takeFailure = (sessionId) => {
				const record = failures.get(sessionId);
				if (record === undefined) return undefined;
				failures.delete(sessionId);
				const age = Date.now() - record.at;
				// An expired record means the error we heard about was not this turn.
				return age >= 0 && age <= FAILURE_TTL_MS ? record.detail : undefined;
			};

			/**
			 * Reports the end of a turn as either a failed or a finished toast.
			 *
			 * @param {string} sessionId
			 * @param {string} backgroundDetail label used when the page was not watching
			 */
			const reportEnd = (sessionId, backgroundDetail) => {
				const failure = takeFailure(sessionId);
				if (failure !== undefined) {
					// A failure is news even when the session is on screen: the page shows
					// it inside the transcript, which is exactly where a user looking at
					// another window will not see it.
					lastEmit.delete(`failed:${sessionId}`);
					send("failed", sessionId, failure);
					return;
				}
				lastEmit.delete(`done:${sessionId}`);
				send("done", sessionId, backgroundDetail);
			};

			/** Compares the new snapshot against `seen` and emits any transitions. */
			const diff = (snapshot) => {
				if (!snapshot || typeof snapshot.forEach !== "function") return;

				snapshot.forEach((state, sessionId) => {
					const id = String(sessionId ?? "");
					if (!id) return;
					const running = state && state.running === true;
					const pending = state ? state.pendingInteraction : undefined;
					const waiting = Boolean(pending);
					const unread = state && state.completionUnread === true;
					const prev = seen.get(id);

					if (prev === undefined) {
						// First sighting: record without notifying, otherwise loading the page
						// would replay every already-waiting session at once.
						seen.set(id, { running, waiting });
						if (waiting) reportedWaiting.add(id);
						return;
					}

					// A new turn invalidates whatever the previous turn ended with.
					if (running && !prev.running) failures.delete(id);

					if (waiting && !prev.waiting) {
						if (!reportedWaiting.has(id)) {
							reportedWaiting.add(id);
							// A fresh waiting episode is a new thing to tell the user about, so it
							// must not be silenced by the cooldown of a previous episode.
							lastEmit.delete(`waiting:${id}`);
							send("waiting", id, describePending(pending));
						}
					} else if (!waiting && prev.waiting) {
						reportedWaiting.delete(id);
						lastEmit.delete(`waiting:${id}`);
					}

					if (!waiting && prev.running && !running) {
						// running -> idle: covers the session you are looking at, which the host's
						// `completionUnread` flag deliberately does not. The verdict (failed vs
						// finished) comes from the failure recorded above.
						reportEnd(id, "任务已完成");
					} else if (unread && !running) {
						// Background session finished while we were not watching it run.
						reportEnd(id, "后台任务已完成");
					}

					seen.set(id, { running, waiting });
				});

				for (const id of Array.from(seen.keys())) {
					if (typeof snapshot.has === "function" && !snapshot.has(id)) {
						seen.delete(id);
						reportedWaiting.delete(id);
					}
				}

				probe(snapshot);
			};

			const stop = () => {
				stopped = true;
				try {
					if (typeof unsubscribe === "function") unsubscribe();
				} catch {
					/* ignore */
				}
				unsubscribe = null;
				try {
					if (typeof unsubscribeFailure === "function") unsubscribeFailure();
				} catch {
					/* ignore */
				}
				unsubscribeFailure = null;
			};

			/**
			 * Records one failed turn, so the idle edge that follows can report it.
			 *
			 * `api-session/error` is emitted by the host from `agent/error`, which the
			 * agent loop only raises for a real failure — never for a user-initiated
			 * stop. It is also the only failure signal reachable from the page: the
			 * sessionStatus snapshot has no room for it.
			 */
			const watchFailures = () => {
				try {
					const remote = ctx.remote;
					if (!remote || typeof remote.$on !== "function") {
						warn("remote channel unavailable; failures will be reported as completions");
						return;
					}
					unsubscribeFailure = remote.$on("api-session/error", (sessionId, message) => {
						if (stopped) return;
						const id = String(sessionId ?? "");
						if (!id) return;
						failures.set(id, { at: Date.now(), detail: describeFailure(message) });
					});
				} catch (err) {
					warn("cannot subscribe to api-session/error", err);
				}
			};

			try {
				if (!statusSource || typeof statusSource.subscribe !== "function") {
					warn("uiSession.sessionStatus unavailable; bridge inactive");
					return;
				}

				const read = () => {
					if (stopped) return;
					try {
						diff(statusSource.getSnapshot());
					} catch (err) {
						warn("diff failed", err);
					}
				};

				read();
				unsubscribe = statusSource.subscribe(read);
				watchFailures();

				if (typeof ctx.effect === "function") ctx.effect(() => stop, "dsh-desktop-bridge: subscription");
			} catch (err) {
				warn("cannot subscribe to sessionStatus", err);
			}

			return stop;
		}

		exports.name = "dsh-desktop-bridge-client";
		exports.inject = inject;
		exports.apply = apply;
		return module.exports;
	}
});
