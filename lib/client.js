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
 * The two signals, and why each needs care:
 *
 *  - `pendingInteraction` is truthy while a session is blocked on the human
 *    (approval / plan review / question). Emit on the rising edge only, or the
 *    user gets a toast storm on every status publication.
 *  - `completionUnread` is set by the host only for sessions that are *not* in
 *    the main view. Reading it alone would miss the common case of a session
 *    finishing while you are looking at it, so a running→idle edge also counts.
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
		 * Both services are read at render time, so both must be declared:
		 * cordis proxies `ctx.<name>` off this list and throws for anything
		 * missing ("cannot get property X without inject").
		 */
		const inject = ["sessions", "uiSession"];

		/** Global the host injects into index.html carrying the bridge token. */
		const TOKEN_GLOBAL = "__DSH_DESKTOP_BRIDGE__";

		const INGEST_PATH = "/__dsh-desktop-bridge/ingest";

		/** Minimum gap between two notifications for the same session and kind. */
		const SAME_KIND_COOLDOWN_MS = 4000;

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

		function apply(ctx) {
			let stopped = false;
			let unsubscribe = null;
			/** Per-session last observed state, so only edges emit. */
			const seen = new Map();
			/** Sessions already reported as waiting, to suppress duplicates. */
			const reportedWaiting = new Set();
			/** `kind:sessionId` -> timestamp of the last emission, for cooldown. */
			const lastEmit = new Map();
			let reachedHost = false;

			const statusSource = ctx.uiSession && ctx.uiSession.sessionStatus;

			const listSnapshot = () => {
				try {
					const src = ctx.sessions && ctx.sessions.list;
					return src && typeof src.getSnapshot === "function" ? src.getSnapshot() : undefined;
				} catch {
					return undefined;
				}
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
					at: Date.now(),
				});

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
						// `completionUnread` flag deliberately does not.
						lastEmit.delete(`done:${id}`);
						send("done", id, "任务已完成");
					} else if (unread && !running) {
						// Background session finished while we were not watching it run.
						lastEmit.delete(`done:${id}`);
						send("done", id, "后台任务已完成");
					}

					seen.set(id, { running, waiting });
				});

				for (const id of Array.from(seen.keys())) {
					if (typeof snapshot.has === "function" && !snapshot.has(id)) {
						seen.delete(id);
						reportedWaiting.delete(id);
					}
				}
			};

			const stop = () => {
				stopped = true;
				try {
					if (typeof unsubscribe === "function") unsubscribe();
				} catch {
					/* ignore */
				}
				unsubscribe = null;
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
