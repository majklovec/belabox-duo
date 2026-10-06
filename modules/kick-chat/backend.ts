/*
 * kick-chat backend — one half of the server-side Kick channel hub. The
 * kick-chat dashboard widgets are device-independent, so the control server
 * keeps a kick.com chat websocket per channel here (auth token optional) and
 * pushes `kick.chat` events (tagged with the channel) to dashboard websocket
 * subscribers. The rolling history keeps reconnections from re-sending, and
 * the `seen` set dedupes message ids. One instance serves all chat widgets.
 */
import { eventFrame, type ChatLive } from "../types";
import type { ChannelSpecs, PublishFn } from "../widgets";

const CHAT_URL = "wss://kick.com/chat";
/** kick.snapshot: per-channel {connected, most recent messages, newest first}. */
export interface ChatSnapshot {
	[channel: string]: { connected: boolean; messages: ChatLive[] };
}
const HISTORY_CAP = 500;
const RECONNECT_BASE_MS = 1_000;
const RECONNECT_MAX_MS = 30_000;

type ChatChannelState = {
	channel: string;
	token: string;
	ws: WebSocket | null;
	stopped: boolean;
	attempt: number;
	reconnectTimer: ReturnType<typeof setTimeout> | null;
	/** most recent messages, newest first */
	history: ChatLive[];
	/** recent message ids, deduped across reconnects */
	seen: Set<string>;
};

function asChatMessage(raw: unknown): ChatLive | null {
	if (!raw || typeof raw !== "object") return null;
	const msg = raw as Record<string, unknown>;
	if (msg.id === undefined || msg.id === null) return null;
	if (msg.message === undefined && msg.text === undefined) return null;
	const out: ChatLive = { id: typeof msg.id === "number" ? msg.id : String(msg.id) };
	if (typeof msg.username === "string") out.username = msg.username;
	if (typeof msg.text === "string") out.text = msg.text;
	if (typeof msg.message === "string") out.text = out.text ?? msg.message;
	return out;
}

/**
 * State manager for kick-chat channels. `sync(specs)` opens websockets for
 * channels not yet attached (re-authing on token change) and stops removed
 * ones.
 */
export class ChatChannelManager {
	#channels = new Map<string, ChatChannelState>();
	#publish: PublishFn;

	constructor(publish: PublishFn) {
		this.#publish = publish;
	}

	start(name: string, token: string): void {
		const key = name.trim().toLowerCase();
		if (!key) return;
		this.stop(key);
		const state: ChatChannelState = {
			channel: key,
			token,
			ws: null,
			stopped: false,
			attempt: 0,
			reconnectTimer: null,
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
		if (state.reconnectTimer) clearTimeout(state.reconnectTimer);
		state.ws?.close();
		state.ws = null;
	}

	sync(specs: ChannelSpecs): void {
		for (const [name, token] of specs) {
			const key = name.trim().toLowerCase();
			if (!key) continue;
			const state = this.#channels.get(key);
			if (!state) this.start(key, token);
			else if (state.token !== token) this.start(key, token);
		}
		for (const key of [...this.#channels.keys()]) {
			if (!specs.has(key)) this.stop(key);
		}
	}

	startedChannels(): string[] {
		return [...this.#channels.keys()];
	}

	/** Rolling history (newest first) per channel plus socket state. */
	snapshot(): ChatSnapshot {
		const out: ChatSnapshot = {};
		for (const [key, state] of this.#channels) {
			out[key] = { connected: state.ws?.readyState === WebSocket.OPEN, messages: [...state.history] };
		}
		return out;
	}

	destroy(): void {
		for (const key of this.startedChannels()) this.stop(key);
	}

	#connect(state: ChatChannelState): void {
		const params = new URLSearchParams({ channel: state.channel });
		if (state.token) params.set("token", state.token);
		let ws: WebSocket;
		try {
			ws = new WebSocket(`${CHAT_URL}?${params}`);
		} catch {
			this.#scheduleReconnect(state);
			return;
		}
		state.ws = ws;
		ws.addEventListener("open", () => {
			state.attempt = 0;
			// Re-deliver the rolling buffer so a fresh viewer can top up.
			this.#publish(eventFrame("kick.chat", { channel: state.channel, reconnect: true, messages: state.history }));
		});
		ws.addEventListener("message", (ev: MessageEvent) => {
			let msg: ChatLive | null = null;
			try {
				msg = asChatMessage(JSON.parse(typeof ev.data === "string" ? ev.data : String(ev.data)));
			} catch {
				return;
			}
			if (!msg) return;
			const key = String(msg.id);
			if (state.seen.has(key)) return;
			state.seen.add(key);
			state.history.unshift(msg);
			if (state.history.length > HISTORY_CAP) state.history.length = HISTORY_CAP;
			// Shed ids of messages evicted from the buffer (newest first, so the
			// tail is oldest) to keep `seen` bounded.
			while (state.seen.size > HISTORY_CAP * 2) {
				const oldest = state.history.pop();
				if (oldest) state.seen.delete(String(oldest.id));
			}
			this.#publish(eventFrame("kick.chat", { channel: state.channel, message: msg }));
		});
		ws.addEventListener("close", () => {
			this.#publish(eventFrame("kick.chat", { channel: state.channel, disconnected: true }));
			this.#scheduleReconnect(state);
		});
		ws.addEventListener("error", () => ws.close());
	}

	#scheduleReconnect(state: ChatChannelState): void {
		if (state.stopped) {
			state.ws = null;
			return;
		}
		const delay = Math.min(RECONNECT_BASE_MS * 2 ** state.attempt, RECONNECT_MAX_MS);
		state.attempt += 1;
		state.ws = null;
		state.reconnectTimer = setTimeout(() => this.#connect(state), delay);
	}
}
