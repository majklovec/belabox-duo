/*
 * tiktok-chat backend — the server-side TikTok channel hub. The tiktok-chat
 * dashboard widgets are device-independent, so the control server keeps one
 * tiktok-live-connector connection per channel here (TikTok chat is public;
 * no auth) and pushes `tiktok.chat` events (tagged with the channel) to
 * dashboard websocket subscribers. One instance serves all chat widgets.
 *
 * TikTok chat rides a proprietary websocket protocol, so the module speaks it
 * through the tiktok-live-connector package: `TikTokLiveConnection.connect()`
 * per channel, one `WebcastEvent.CHAT` listener per connection. The connector
 * has no built-in auto-reconnect, so this manager owns the reconnection loop
 * (same exponential backoff as kick-chat); the rolling history keeps
 * reconnections from re-sending, and the `seen` set dedupes msg ids across
 * reconnects.
 */
import { ControlEvent, TikTokLiveConnection, WebcastEvent } from "tiktok-live-connector";
import { eventFrame, type ChatLive, type ChannelSpecs, type PublishFn } from "./types";

const HISTORY_CAP = 500;
const RECONNECT_BASE_MS = 1_000;
const RECONNECT_MAX_MS = 30_000;
/** Max ms to wait for fetchRoomId (signs in to get the room id) before giving
 * up this attempt and reconnecting. */
const CONNECT_TIMEOUT_MS = 15_000;

/** tiktok.snapshot: per-channel {connected, most recent messages, newest first}. */
export interface ChatSnapshot {
	[channel: string]: { connected: boolean; messages: ChatLive[] };
}

/** tiktok-chat widget's configurable parameters (single source for the server
 * validation and the frontend editor). */
export const TIKTOK_CHAT_CONFIG_FIELDS = ["channel"] as const;

/** Channel-hub spec from one widget's config (null when no channel set). */
export function tiktokChatSpecFromConfig(config: Record<string, string> | undefined): string | null {
	const name = (config?.["channel"] ?? "").trim().toLowerCase();
	return name || null;
}

type ChatChannelState = {
	channel: string;
	conn: TikTokLiveConnection | null;
	stopped: boolean;
	connected: boolean;
	attempt: number;
	reconnectTimer: ReturnType<typeof setTimeout> | null;
	connectTimer: ReturnType<typeof setTimeout> | null;
	/** most recent messages, newest first */
	history: ChatLive[];
	/** recent msg ids, deduped across reconnects */
	seen: Set<string>;
};

/**
 * Map one TikTok chat message to the wire shape. The raw payload is the
 * connector's v3 proto `WebcastChatMessage`: {user: {nickname}, content,
 * common: {msgId}}. `id` falls back to a content-derived digest only when the
 * stream omits its message id (dedup quality, not identity).
 */
function asChatMessage(raw: unknown): ChatLive | null {
	if (!raw || typeof raw !== "object") return null;
	const msg = raw as {
		user?: { nickname?: string; uniqueId?: string } | null;
		content?: string;
		common?: { msgId?: string; logId?: string } | null;
	};
	const text = typeof msg.content === "string" ? msg.content.trim() : "";
	const username = typeof msg.user?.nickname === "string" ? msg.user.nickname : typeof msg.user?.uniqueId === "string" ? msg.user.uniqueId : undefined;
	if (!text && !username) return null;
	const id = msg.common?.msgId || msg.common?.logId || `${username ?? ""}:${text}:${Date.now()}`;
	const out: ChatLive = { id };
	if (username) out.username = username;
	if (text) out.text = text;
	out.ts = Date.now();
	return out;
}

/**
 * State manager for tiktok-chat channels. `sync(specs)` starts channels not
 * yet attached and stops removed ones.
 */
export class ChatChannelManager {
	#channels = new Map<string, ChatChannelState>();
	#publish: PublishFn;

	constructor(publish: PublishFn) {
		this.#publish = publish;
	}

	start(name: string): void {
		const key = name.trim().toLowerCase();
		if (!key) return;
		this.stop(key);
		const state: ChatChannelState = {
			channel: key,
			conn: null,
			stopped: false,
			connected: false,
			attempt: 0,
			reconnectTimer: null,
			connectTimer: null,
			history: [],
			seen: new Set(),
		};
		this.#channels.set(key, state);
		this.#connect(state);
	}

	stop(channel: string): void {
		const key = channel.trim().toLowerCase();
		const state = this.#channels.get(key);
		if (!state) return;
		this.#channels.delete(key);
		state.stopped = true;
		this.#disarmTimer(state);
		state.conn?.disconnect();
		state.conn = null;
	}

	sync(specs: ChannelSpecs): void {
		for (const name of specs) {
			const key = name.trim().toLowerCase();
			if (key && !this.#channels.has(key)) this.start(key);
		}
		for (const key of [...this.#channels.keys()]) {
			if (!specs.has(key)) this.stop(key);
		}
	}

	startedChannels(): string[] {
		return [...this.#channels.keys()];
	}

	/** Rolling history (newest first) per channel plus connection state. */
	snapshot(): ChatSnapshot {
		const out: ChatSnapshot = {};
		for (const [key, state] of this.#channels) {
			out[key] = { connected: state.connected, messages: [...state.history] };
		}
		return out;
	}

	destroy(): void {
		for (const key of this.startedChannels()) this.stop(key);
	}

	#connect(state: ChatChannelState): void {
		const conn = new TikTokLiveConnection(`@${state.channel}`, { processInitialData: false });
		state.conn = conn;
		conn.on(WebcastEvent.CHAT, (raw: unknown) => {
			if (state.stopped || !state.connected) return;
			const line = asChatMessage(raw);
			if (!line) return;
			const key = String(line.id);
			if (state.seen.has(key)) return;
			state.seen.add(key);
			state.history.unshift(line);
			if (state.history.length > HISTORY_CAP) state.history.length = HISTORY_CAP;
			// Shed ids of messages evicted from the buffer (newest first, so the
			// tail is oldest) to keep `seen` bounded.
			while (state.seen.size > HISTORY_CAP * 2) {
				const oldest = state.history.pop();
				if (oldest) state.seen.delete(String(oldest.id));
			}
			this.#publish(eventFrame("tiktok.chat", { channel: state.channel, message: line }));
		});
		conn.on(ControlEvent.CONNECTED, () => {
			if (state.stopped) return;
			const was = state.connected;
			state.connected = true;
			state.attempt = 0;
			this.#disarmTimer(state);
			// Re-deliver the rolling buffer so a fresh viewer can top up.
			if (!was) this.#publish(eventFrame("tiktok.chat", { channel: state.channel, reconnect: true, messages: state.history }));
		});
		conn.on(ControlEvent.DISCONNECTED, (reason: unknown) => {
			if (state.stopped) return;
			const was = state.connected;
			state.connected = false;
			if (was) this.#publish(eventFrame("tiktok.chat", { channel: state.channel, disconnected: true }));
			if (reason && typeof reason === "object" && "message" in reason) {
				console.warn(`[tiktok-chat ${state.channel}] disconnected: ${String(reason.message)}`);
			}
			this.#scheduleReconnect(state);
		});
		conn.on(ControlEvent.ERROR, (err: unknown) => {
			if (state.stopped) return;
			this.#logError(state, err);
		});
		// fetchRoomId can hang (offline room, slow CDN) — cap the attempt.
		state.connectTimer = setTimeout(() => this.#onConnectFail(state, "connect timeout"), CONNECT_TIMEOUT_MS);
		void conn.connect().catch((err: unknown) => {
			this.#logError(state, err);
			this.#onConnectFail(state, "connect failed");
		});
	}

	#logError(state: ChatChannelState, err: unknown): void {
		const detail =
			err instanceof Error ? err.message :
			err && typeof err === "object" ? JSON.stringify(err) : String(err);
		console.warn(`[tiktok-chat ${state.channel}] error: ${detail}`);
	}

	#onConnectFail(state: ChatChannelState, reason: string): void {
		this.#disarmTimer(state);
		if (state.stopped) {
			state.conn = null;
			return;
		}
		const was = state.connected;
		state.connected = false;
		if (was) this.#publish(eventFrame("tiktok.chat", { channel: state.channel, disconnected: true }));
		state.conn?.disconnect();
		state.conn = null;
		this.#scheduleReconnect(state);
	}

	#disarmTimer(state: ChatChannelState): void {
		if (state.connectTimer) {
			clearTimeout(state.connectTimer);
			state.connectTimer = null;
		}
		if (state.reconnectTimer) {
			clearTimeout(state.reconnectTimer);
			state.reconnectTimer = null;
		}
	}

	#scheduleReconnect(state: ChatChannelState): void {
		if (state.stopped) {
			state.conn = null;
			return;
		}
		const delay = Math.min(RECONNECT_BASE_MS * 2 ** state.attempt, RECONNECT_MAX_MS);
		state.attempt += 1;
		state.conn = null;
		state.reconnectTimer = setTimeout(() => this.#connect(state), delay);
	}
}

/** Widget registration (the backend registry's hub wiring); the core reaches
 * this module only through it, no per-module imports in the core. */
export default {
	id: "tiktok-chat",
	kind: "widget" as const,
	title: "TikTok Chat",
	hub: {
		widgetType: "tiktok-chat",
		snapshotKey: "tiktokChat",
		configFields: TIKTOK_CHAT_CONFIG_FIELDS,
		channelSpec: tiktokChatSpecFromConfig,
		create: (publish: PublishFn): ChatChannelManager => new ChatChannelManager(publish),
	},
};
