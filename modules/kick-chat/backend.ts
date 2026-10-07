/*
 * kick-chat backend — one half of the server-side Kick channel hub. The
 * kick-chat dashboard widgets are device-independent, so the control server
 * keeps a Kick chat websocket per channel here (the widget's optional token is
 * unused: Kick chat is public) and pushes `kick.chat` events (tagged with the
 * channel) to dashboard websocket subscribers. One instance serves all chat
 * widgets.
 *
 * Kick does not expose a direct chat websocket — chat rides Pusher. Each
 * channel is resolved to its chatroom id through kick.com's public REST API,
 * joined on Pusher's public app, and the unauthenticated `chatrooms.<id>.v2`
 * channel is subscribed; each `App\Events\ChatMessageEvent` payload becomes a
 * `kick.chat` push. The rolling history keeps reconnections from re-sending,
 * and the `seen` set dedupes message ids across reconnects.
 */
import { eventFrame, type ChatLive } from "../types";
import type { ChannelSpecs, PublishFn } from "../widgets";

/** Kick's public Pusher chat app (protocol 7, anonymous join). */
const PUSHER_URL =
	"wss://ws-us2.pusher.com/app/32cbd69e4b950bf97679?protocol=7&client=js&version=8.4.0-rc2&flash=false";
/** Channel slug -> chatroom id lookup. */
const KICK_CHANNEL_API = "https://kick.com/api/v2/channels";
const RESOLVE_TIMEOUT_MS = 10_000;
/** Give up on the subscribe handshake when it does not complete in time. */
const SUBSCRIBE_TIMEOUT_MS = 10_000;
const HISTORY_CAP = 500;
const RECONNECT_BASE_MS = 1_000;
const RECONNECT_MAX_MS = 30_000;

/** kick.snapshot: per-channel {connected, most recent messages, newest first}. */
export interface ChatSnapshot {
	[channel: string]: { connected: boolean; messages: ChatLive[] };
}

/** kick-chat widget's configurable parameters (single source for the server
 * validation and the frontend editor). */
export const KICK_CHAT_CONFIG_FIELDS = ["channel", "token"] as const;

/** Channel-hub spec from one widget's config (null when no channel set). */
export function chatSpecFromConfig(config: Record<string, string> | undefined): { name: string; token: string } | null {
	const name = (config?.["channel"] ?? "").trim().toLowerCase();
	if (!name) return null;
	return { name, token: config?.["token"] ?? "" };
}

type ChatChannelState = {
	channel: string;
	chatroom: number | null;
	ws: WebSocket | null;
	stopped: boolean;
	subscribed: boolean;
	attempt: number;
	reconnectTimer: ReturnType<typeof setTimeout> | null;
	subscribeTimer: ReturnType<typeof setTimeout> | null;
	/** most recent messages, newest first */
	history: ChatLive[];
	/** recent message ids, deduped across reconnects */
	seen: Set<string>;
};

/** Resolve a channel slug to the chatroom id hosting its chat. */
async function resolveChatroom(slug: string): Promise<number> {
	const res = await fetch(`${KICK_CHANNEL_API}/${encodeURIComponent(slug)}`, {
		headers: { accept: "application/json" },
		signal: AbortSignal.timeout(RESOLVE_TIMEOUT_MS),
	});
	if (!res.ok) throw new Error(`kick channel HTTP ${res.status}`);
	const data = (await res.json()) as { chatroom?: { id?: number } };
	const id = data.chatroom?.id;
	if (id === undefined || id === null) throw new Error("no chatroom id in response");
	return id;
}

/** Map one Pusher ChatMessageEvent payload to the wire shape. */
function asChatMessage(raw: unknown): ChatLive | null {
	if (!raw || typeof raw !== "object") return null;
	const msg = raw as Record<string, unknown>;
	if (msg.id === undefined || msg.id === null) return null;
	const sender = (msg.sender as Record<string, unknown> | undefined) ?? {};
	const username = typeof sender.username === "string" ? sender.username : undefined;
	const identity = (sender.identity as Record<string, unknown> | undefined) ?? {};
	const color = typeof identity.color === "string" && /^#[0-9a-fA-F]{3,8}$/.test(identity.color)
		? identity.color
		: undefined;
	const text =
		typeof msg.content === "string" && msg.content !== ""
			? msg.content
			: typeof msg.message === "string" && msg.message !== ""
				? msg.message
				: undefined;
	if (username === undefined && text === undefined) return null;
	const out: ChatLive = { id: typeof msg.id === "number" ? msg.id : String(msg.id) };
	if (username) out.username = username;
	if (color) out.color = color;
	if (text) out.text = text;
	if (typeof msg.created_at === "string") {
		const ts = Date.parse(msg.created_at);
		if (Number.isFinite(ts)) out.ts = ts;
	}
	return out;
}

/**
 * State manager for kick-chat channels. `sync(specs)` starts channels not yet
 * attached (token changes are ignored — public chat needs no auth) and stops
 * removed ones.
 */
export class ChatChannelManager {
	#channels = new Map<string, ChatChannelState>();
	#publish: PublishFn;

	constructor(publish: PublishFn) {
		this.#publish = publish;
	}

	start(name: string, _token: string): void {
		const key = name.trim().toLowerCase();
		if (!key) return;
		this.stop(key);
		const state: ChatChannelState = {
			channel: key,
			chatroom: null,
			ws: null,
			stopped: false,
			subscribed: false,
			attempt: 0,
			reconnectTimer: null,
			subscribeTimer: null,
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
		this.#disarmSubscribeTimer(state);
		if (state.reconnectTimer) clearTimeout(state.reconnectTimer);
		state.ws?.close();
		state.ws = null;
	}

	sync(specs: ChannelSpecs): void {
		for (const [name] of specs) {
			const key = name.trim().toLowerCase();
			if (key && !this.#channels.has(key)) this.start(key, "");
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
			out[key] = { connected: state.subscribed, messages: [...state.history] };
		}
		return out;
	}

	destroy(): void {
		for (const key of this.startedChannels()) this.stop(key);
	}

	/** Resolve the chatroom id, then join its Pusher chatroom channel. */
	#connect(state: ChatChannelState): void {
		void resolveChatroom(state.channel)
			.then((chatroom) => {
				if (state.stopped) return;
				state.chatroom = chatroom;
				const ws = new WebSocket(PUSHER_URL);
				state.ws = ws;
				ws.addEventListener("message", (ev: MessageEvent) => this.#onPusherMessage(state, ev));
				ws.addEventListener("close", () => this.#onPusherClose(state));
				ws.addEventListener("error", () => ws.close());
				this.#armSubscribeTimer(state);
			})
			.catch((err: unknown) => {
				console.warn(`[kick-chat ${state.channel}] resolve failed: ${err instanceof Error ? err.message : String(err)}`);
				this.#scheduleReconnect(state);
			});
	}

	#onPusherMessage(state: ChatChannelState, ev: MessageEvent): void {
		if (!state.chatroom || !state.ws) return;
		const raw = typeof ev.data === "string" ? ev.data : String(ev.data);
		let msg: { event?: string; data?: unknown };
		try {
			msg = JSON.parse(raw) as { event?: string; data?: unknown };
		} catch {
			return;
		}
		switch (msg.event) {
			case "pusher:connection_established":
				state.ws.send(
					JSON.stringify({
						event: "pusher:subscribe",
						data: { auth: "", channel: `chatrooms.${state.chatroom}.v2` },
					}),
				);
				break;
			case "pusher:ping":
				state.ws.send(JSON.stringify({ event: "pusher:pong", data: {} }));
				break;
			case "pusher_internal:subscription_succeeded":
				this.#disarmSubscribeTimer(state);
				state.subscribed = true;
				state.attempt = 0;
				// Re-deliver the rolling buffer so a fresh viewer can top up.
				this.#publish(eventFrame("kick.chat", { channel: state.channel, reconnect: true, messages: state.history }));
				break;
			case "App\\Events\\ChatMessageEvent": {
				let payload: unknown;
				try {
					payload = typeof msg.data === "string" ? JSON.parse(msg.data) : msg.data;
				} catch {
					return;
				}
				const line = asChatMessage(payload);
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
				this.#publish(eventFrame("kick.chat", { channel: state.channel, message: line }));
				break;
			}
			default:
				break;
		}
	}

	#onPusherClose(state: ChatChannelState): void {
		this.#disarmSubscribeTimer(state);
		if (state.subscribed) {
			state.subscribed = false;
			this.#publish(eventFrame("kick.chat", { channel: state.channel, disconnected: true }));
		}
		this.#scheduleReconnect(state);
	}

	#armSubscribeTimer(state: ChatChannelState): void {
		this.#disarmSubscribeTimer(state);
		state.subscribeTimer = setTimeout(() => state.ws?.close(), SUBSCRIBE_TIMEOUT_MS);
	}

	#disarmSubscribeTimer(state: ChatChannelState): void {
		if (state.subscribeTimer) {
			clearTimeout(state.subscribeTimer);
			state.subscribeTimer = null;
		}
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
