/*
 * Server-side Kick channel hub: the kick-stats / kick-chat dashboard widgets
 * are device-independent, so the control server owns their data. Per channel
 * it polls Kick's public channel stats API every 30 seconds and keeps a chat
 * WebSocket open, then broadcasts `kick.stats` / `kick.chat` events (tagged
 * with the channel) to all dashboard viewers. New viewers receive a
 * `kick.snapshot` of the latest samples and rolling chat history on connect.
 */
import type { KickChatMessage, KickStats, ServerDashboard } from "../public/types";

export const KICK_STATS_POLL_MS = 30_000;
const FETCH_TIMEOUT_MS = 10_000;
const CHAT_URL = "wss://kick.com/chat";
const HISTORY_CAP = 500;
const RECONNECT_BASE_MS = 1_000;
const RECONNECT_MAX_MS = 30_000;
const KICK_API = "https://kick.com/api/v1";

export interface KickSnapshot {
	/** normalized channel -> latest polled stats */
	stats: Record<string, KickStats | null>;
	/** normalized channel -> {connected, most recent messages, newest first} */
	chat: Record<string, { connected: boolean; messages: KickChatMessage[] }>;
}

/** Desired state: normalized channel name -> chat token ("" when none). */
export type KickChannelSpecs = Map<string, string>;

export const normalizeChannel = (name: string): string => name.trim().toLowerCase();

interface ChannelState {
	channel: string;
	token: string;
	stats: KickStats | null;
	polling: boolean;
	timer: ReturnType<typeof setInterval> | null;
	ws: WebSocket | null;
	stopped: boolean;
	attempt: number;
	reconnectTimer: ReturnType<typeof setTimeout> | null;
	history: KickChatMessage[];
	seen: Set<string>;
}

const event = (name: string, data: unknown) => JSON.stringify({ type: "event", event: name, data });

/**
 * Create a hub. `publish` delivers serialized `event` frames to all dashboard
 * viewer sockets (call `hub.snapshot()` on each viewer's open to warm-start).
 */
export function createKickHub(publish: (msg: string) => void) {
	const channels = new Map<string, ChannelState>();

	// ------------------------------------------------------------------ stats

	function startStats(c: ChannelState): void {
		stopStats(c);
		void poll(c);
		c.timer = setInterval(() => void poll(c), KICK_STATS_POLL_MS);
	}

	function stopStats(c: ChannelState): void {
		if (c.timer) {
			clearInterval(c.timer);
			c.timer = null;
		}
	}

	async function poll(c: ChannelState): Promise<void> {
		if (c.polling) return;
		c.polling = true;
		try {
			const controller = new AbortController();
			const timeout = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
			const res = await fetch(`${KICK_API}/channels/${encodeURIComponent(c.channel)}/stats`, {
				signal: controller.signal,
				headers: { accept: "application/json" },
			});
			clearTimeout(timeout);
			if (!res.ok) throw new Error(`kick stats HTTP ${res.status}`);
			const payload = (await res.json()) as { data?: KickStats };
			c.stats = { ...(payload.data ?? {}), at: Date.now() };
			publish(event("kick.stats", { channel: c.channel, stats: c.stats }));
		} catch (err: unknown) {
			console.warn(`[kick ${c.channel}] stats poll failed: ${err instanceof Error ? err.message : String(err)}`);
		} finally {
			c.polling = false;
		}
	}

	// ------------------------------------------------------------------- chat

	function stopChat(c: ChannelState): void {
		c.stopped = true;
		if (c.reconnectTimer) {
			clearTimeout(c.reconnectTimer);
			c.reconnectTimer = null;
		}
		c.ws?.close();
		c.ws = null;
	}

	function connectChat(c: ChannelState): void {
		const params = `channel=${encodeURIComponent(c.channel)}`;
		const url = c.token ? `${CHAT_URL}?${params}&token=${encodeURIComponent(c.token)}` : `${CHAT_URL}?${params}`;
		try {
			c.ws = new WebSocket(url);
		} catch {
			scheduleReconnect(c);
			return;
		}
		c.ws.addEventListener("open", () => {
			c.attempt = 0;
			// Re-deliver the rolling buffer so a fresh viewer can top up.
			publish(event("kick.chat", { channel: c.channel, reconnect: true, messages: c.history }));
		});
		c.ws.addEventListener("message", (ev: MessageEvent) => {
			let msg: KickChatMessage;
			try {
				msg = JSON.parse(typeof ev.data === "string" ? ev.data : String(ev.data)) as KickChatMessage;
			} catch {
				return;
			}
			if (msg.id === undefined || msg.id === null) return;
			const key = String(msg.id);
			if (c.seen.has(key)) return;
			c.seen.add(key);
			while (c.seen.size > HISTORY_CAP * 2) {
				const oldest = c.history.shift();
				if (oldest) c.seen.delete(String(oldest.id));
			}
			c.history.push(msg);
			publish(event("kick.chat", { channel: c.channel, message: msg }));
		});
		c.ws.addEventListener("close", () => {
			publish(event("kick.chat", { channel: c.channel, disconnected: true }));
			scheduleReconnect(c);
		});
		c.ws.addEventListener("error", () => {
			c.ws?.close();
		});
	}

	function scheduleReconnect(c: ChannelState): void {
		if (c.stopped) {
			c.ws = null;
			return;
		}
		const delay = Math.min(RECONNECT_BASE_MS * 2 ** c.attempt, RECONNECT_MAX_MS);
		c.attempt += 1;
		c.ws = null;
		c.reconnectTimer = setTimeout(() => connectChat(c), delay);
	}

	// ------------------------------------------------------------------ sync

	/**
	 * Apply the desired set of channels: start poller + chat socket for new
	 * ones, stop the removed ones. The token only affects the chat socket.
	 */
	function sync(specs: KickChannelSpecs): void {
		for (const [name, token] of specs) {
			const channel = normalizeChannel(name);
			if (!channel) continue;
			let c = channels.get(channel);
			if (!c) {
				c = {
					channel,
					token: "",
					stats: null,
					polling: false,
					timer: null,
					ws: null,
					stopped: true,
					attempt: 0,
					reconnectTimer: null,
					history: [],
					seen: new Set(),
				};
				channels.set(channel, c);
			}
			const changed = c.token !== token;
			c.token = token;
			startStats(c);
			if (changed) {
				stopChat(c);
				c.stopped = false;
				c.attempt = 0;
				connectChat(c);
			}
		}
		for (const [channel, c] of [...channels]) {
			if (specs.has(channel)) continue;
			stopStats(c);
			stopChat(c);
			channels.delete(channel);
		}
	}

	/** Latest samples + chat history for warm-starting a new dashboard viewer. */
	function snapshot(): KickSnapshot {
		const out: KickSnapshot = { stats: {}, chat: {} };
		for (const [channel, c] of channels) {
			out.stats[channel] = c.stats;
			out.chat[channel] = {
				connected: c.ws?.readyState === WebSocket.OPEN,
				messages: c.history.slice(-500).reverse(),
			};
		}
		return out;
	}

	/** Stop everything (server shutdown). */
	function destroy(): void {
		for (const c of channels.values()) {
			stopStats(c);
			stopChat(c);
		}
		channels.clear();
	}

	return { sync, snapshot, destroy };
}

/** Desired channels across all dashboards: widget config channel -> chat token. */
export function channelSpecsFromDashboards(dashboards: ServerDashboard[]): KickChannelSpecs {
	const specs: KickChannelSpecs = new Map();
	for (const dash of dashboards) {
		for (const w of dash.widgets) {
			if (w.type !== "kick-stats" && w.type !== "kick-chat") continue;
			const channel = normalizeChannel(w.config?.channel ?? "");
			if (!channel) continue;
			const token = typeof w.config?.token === "string" ? w.config.token : "";
			specs.set(channel, token || specs.get(channel) || "");
		}
	}
	return specs;
}
