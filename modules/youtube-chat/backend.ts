/*
 * youtube-chat backend — the server-side YouTube channel hub. The youtube-chat
 * dashboard widgets are device-independent, so the control server keeps one
 * poller per channel here (YouTube chat needs no auth) and pushes
 * `youtube.chat` events (tagged with the channel) to dashboard websocket
 * subscribers. One instance serves all chat widgets.
 *
 * The widget's `channel` config is the creator handle (e.g. `@lofigirl`).
 * Each channel polls YouTube's live-chat endpoint (`fetchLivePage` +
 * `fetchChat` from youtube-chat-next) on a *fixed* ~1s cadence of its own,
 * ignoring YouTube's suggested `timeoutMs` throttle (10s in practice) so
 * messages land within about a second, like the reference
 * next-youtube-livechat client does. The rolling history keeps reconnections
 * from re-sending, and the `seen` set dedupes message ids across reconnects.
 * Offline streams make the first fetch reject — treated like a disconnect
 * and retried with backoff.
 */
import { fetchChat, fetchLivePage } from "youtube-chat-next/dist/requests";
import type { FetchOptions } from "youtube-chat-next/dist/types/yt-response";
import type { ChatItem } from "youtube-chat-next/dist/types/data";
import { RateLimitError, ScrapeError } from "youtube-chat-next";
import { eventFrame, type ChatLive } from "../types";
import type { ChannelSpecs, PublishFn } from "../widgets";

const HISTORY_CAP = 500;
const RECONNECT_BASE_MS = 1_000;
const RECONNECT_MAX_MS = 30_000;
/** Fixed poll cadence in ms. Deliberately ignores YouTube's `timeoutMs`
 * response field (10s in practice): polling every second keeps message
 * latency at ~1s. Consecutive-failure counter caps the retry rate. */
const POLL_INTERVAL_MS = 1_000;
/** After this many consecutive poll failures the channel gives up and
 * reconnects with backoff (the page may have changed, e.g. stream ended). */
const MAX_POLL_FAILURES = 5;

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

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
	/** true while the poll loop for this channel is running */
	polling: boolean;
	stopped: boolean;
	connected: boolean;
	attempt: number;
	reconnectTimer: ReturnType<typeof setTimeout> | null;
	/** most recent messages, newest first */
	history: ChatLive[];
	/** recent message ids, deduped across reconnects */
	seen: Set<string>;
};

/** Map one chat ChatItem to the wire shape (text parts joined, emoji parts
 * rendered by their unicode/label). */
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
			polling: false,
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
		// The poll loop exits on its next `stopped` check.
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

	/** Resolve one poll round's chat items: dedupe, buffer, push. */
	#applyItems(state: ChatChannelState, items: ChatItem[]): void {
		for (const item of items) {
			if (state.stopped) return;
			const line = asChatMessage(item);
			if (!line) continue;
			const key = String(line.id);
			if (state.seen.has(key)) continue;
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
		}
	}

	#connect(state: ChatChannelState): void {
		if (state.stopped || state.polling) return;
		state.polling = true;

		// The config value carries no `@` (normalized in channelOf); YouTube's
		// handle does.
		const handle = state.channel.startsWith("@") ? state.channel : `@${state.channel}`;

		const loop = async (): Promise<void> => {
			const errText = (err: unknown): string => (err instanceof Error ? err.message : String(err));

			let options: FetchOptions | null = null;
			try {
				options = await fetchLivePage({ handle }, "live");
			} catch (err) {
				// Offline stream (NotLiveError) or transient failure — "try
				// again later".
				if (!state.stopped) console.warn(`[youtube-chat ${state.channel}] live page: ${errText(err)}`);
				this.#onEnd(state);
				return;
			}

			let failures = 0;
			while (!state.stopped) {
				try {
					const [items, continuation] = await fetchChat(options);
					failures = 0;
					if (!continuation) {
						// Empty continuation — the stream ended.
						this.#onEnd(state);
						return;
					}
					if (!state.connected) {
						state.connected = true;
						state.attempt = 0;
						// Re-deliver the rolling buffer so a fresh viewer can
						// top up.
						this.#publish(eventFrame("youtube.chat", { channel: state.channel, reconnect: true, messages: state.history }));
					}
					this.#applyItems(state, items);
					options.continuation = continuation;
				} catch (err) {
					if (state.stopped) return;
					// ScrapeError means the response shape no longer parses —
					// retrying won't help until a reconnect re-resolves it.
					if (err instanceof ScrapeError) {
						console.warn(`[youtube-chat ${state.channel}] scrape error: ${errText(err)} (field: ${err.field})`);
						this.#onEnd(state);
						return;
					}
					failures += 1;
					console.warn(`[youtube-chat ${state.channel}] poll: ${errText(err)}`);
					if (failures >= MAX_POLL_FAILURES) {
						this.#onEnd(state);
						return;
					}
					if (err instanceof RateLimitError && err.retryAfterMs) {
						// Honor YouTube's rate-limit ask on this tick, then
						// resume the normal cadence.
						await sleep(err.retryAfterMs);
					}
				}
				// Fixed cadence. Awaiting the fetch before the next tick also
				// guarantees requests never overlap (overlapping polls would
				// race on the continuation token).
				await sleep(POLL_INTERVAL_MS);
			}
		};
		void loop();
	}

	#onEnd(state: ChatChannelState): void {
		if (state.stopped) return;
		state.polling = false;
		const was = state.connected;
		state.connected = false;
		if (was) this.#publish(eventFrame("youtube.chat", { channel: state.channel, disconnected: true }));
		this.#scheduleReconnect(state);
	}

	#scheduleReconnect(state: ChatChannelState): void {
		if (state.stopped) return;
		const delay = Math.min(RECONNECT_BASE_MS * 2 ** state.attempt, RECONNECT_MAX_MS);
		state.attempt += 1;
		state.reconnectTimer = setTimeout(() => this.#connect(state), delay);
	}
}
