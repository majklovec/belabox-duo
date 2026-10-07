/*
 * youtube-chat backend — the server-side YouTube channel hub. The youtube-chat
 * dashboard widgets are device-independent, so the control server keeps one
 * LiveChat poller (youtube-chat-next package) per channel here (YouTube chat
 * needs no auth) and pushes `youtube.chat` events (tagged with the channel)
 * to dashboard websocket subscribers. One instance serves all chat widgets.
 *
 * The widget's `channel` config is the creator handle (e.g. `@lofigirl`).
 * LiveChat polls YouTube's live-chat endpoint; every `chat` event becomes a
 * `youtube.chat` push. The rolling history keeps reconnections from
 * re-sending, and the `seen` set dedupes message ids across reconnects.
 * Offline streams make `start()` reject — treated like a disconnect and
 * retried with backoff.
 */
import { LiveChat } from "youtube-chat-next";
import type { ChatItem } from "youtube-chat-next";
import { eventFrame, type ChatLive } from "../types";
import type { ChannelSpecs, PublishFn } from "../widgets";

const HISTORY_CAP = 500;
const RECONNECT_BASE_MS = 1_000;
const RECONNECT_MAX_MS = 30_000;
/** Minimum ms between polls (YouTube states its own preferred cadence; we
 * honour whichever is slower). */
const POLL_INTERVAL_MS = 1_000;

/** youtube.snapshot: per-channel {connected, most recent messages, newest first}. */
export interface ChatSnapshot {
	[channel: string]: { connected: boolean; messages: ChatLive[] };
}

/** youtube-chat widget's configurable parameters (single source for the
 * server validation and the frontend editor). */
export const YOUTUBE_CHAT_CONFIG_FIELDS = ["channel"] as const;

/** Channel-hub spec from one widget's config (null when no channel set). */
export function youtubeChatSpecFromConfig(config: Record<string, string> | undefined): string | null {
	const name = (config?.["channel"] ?? "").trim().toLowerCase();
	return name || null;
}

type ChatChannelState = {
	channel: string;
	chat: LiveChat | null;
	stopped: boolean;
	connected: boolean;
	attempt: number;
	reconnectTimer: ReturnType<typeof setTimeout> | null;
	/** most recent messages, newest first */
	history: ChatLive[];
	/** recent message ids, deduped across reconnects */
	seen: Set<string>;
};

/** Map one LiveChat ChatItem to the wire shape (text parts joined, emoji
 * parts rendered by their unicode/label). */
function asChatMessage(item: ChatItem): ChatLive | null {
	const text = item.message
		.map((part) => ("text" in (part as object) ? (part as { text: string }).text : (part as { emojiText: string }).emojiText))
		.join("");
	return { id: item.id, username: item.author?.name, text, ts: item.timestamp.getTime() };
}

/**
 * State manager for youtube-chat channels. `sync(specs)` starts channels not
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
			chat: null,
			stopped: false,
			connected: false,
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
		state.chat?.stop();
		state.chat = null;
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

	/** Rolling history (newest first) per channel plus poller state. */
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
		// The config value carries no `@` (normalized in channelOf); YouTube's
		// handle does.
		const handle = state.channel.startsWith("@") ? state.channel : `@${state.channel}`;
		const chat = new LiveChat({ handle }, POLL_INTERVAL_MS, "live");
		state.chat = chat;
		this.#wire(state, chat);
		void this.#start(state, chat);
	}

	#start(state: ChatChannelState, chat: LiveChat): void {
		chat
			.start()
			.then((ok) => {
				if (state.stopped) {
					chat.stop();
					state.chat = null;
					return;
				}
				if (!ok) this.#onEnd(state);
			})
			.catch((err: unknown) => {
				// Offline stream (NotLiveError) or transient scrape failure —
				// both are "try again later".
				if (state.stopped) {
					try {
						chat.stop();
					} catch {
						/* already stopped */
					}
					state.chat = null;
					return;
				}
				this.#onEnd(state);
			});
	}

	#wire(state: ChatChannelState, chat: LiveChat): void {
		chat.on("start", () => {
			if (state.stopped) return;
			const was = state.connected;
			state.connected = true;
			state.attempt = 0;
			// Re-deliver the rolling buffer so a fresh viewer can top up.
			if (!was) this.#publish(eventFrame("youtube.chat", { channel: state.channel, reconnect: true, messages: state.history }));
		});
		chat.on("end", (reason?: string) => {
			if (reason && !state.stopped) console.info(`[youtube-chat ${state.channel}] chat ended: ${reason}`);
			this.#onEnd(state);
		});
		chat.on("error", (err: unknown) => {
			if (state.stopped) return;
			console.warn(`[youtube-chat ${state.channel}] error: ${err instanceof Error ? err.message : String(err)}`);
		});
		chat.on("chat", (item: ChatItem) => {
			if (state.stopped || !state.connected) return;
			const line = asChatMessage(item);
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
			this.#publish(eventFrame("youtube.chat", { channel: state.channel, message: line }));
		});
	}

	#onEnd(state: ChatChannelState): void {
		if (state.stopped) {
			state.chat = null;
			return;
		}
		const was = state.connected;
		state.connected = false;
		state.chat?.stop();
		state.chat = null;
		if (was) this.#publish(eventFrame("youtube.chat", { channel: state.channel, disconnected: true }));
		this.#scheduleReconnect(state);
	}

	#scheduleReconnect(state: ChatChannelState): void {
		if (state.stopped) {
			state.chat = null;
			return;
		}
		const delay = Math.min(RECONNECT_BASE_MS * 2 ** state.attempt, RECONNECT_MAX_MS);
		state.attempt += 1;
		state.reconnectTimer = setTimeout(() => this.#connect(state), delay);
	}
}
