/**
 * YouTube chat provider — polls the creator's live chat on a fixed ~1 s
 * cadence (youtube-chat-next `fetchLivePage` + `fetchChat`), ignoring
 * YouTube's suggested `timeoutMs` throttle so messages land within about a
 * second. The config value carries no `@`; the poll adds it back for the
 * handle. Offline streams make the first fetch reject — treated like a
 * disconnect and retried with backoff; five consecutive poll failures (or a
 * ScrapeError, whose response shape no longer parses) force a full
 * reconnect, since the page may have changed (e.g. the stream ended).
 */
import { fetchChat, fetchLivePage } from "youtube-chat-next/dist/requests";
import type { FetchOptions } from "youtube-chat-next/dist/types/yt-response";
import type { ChatItem } from "youtube-chat-next/dist/types/data";
import { RateLimitError, ScrapeError } from "youtube-chat-next";
import type { ChatLive, PublishFn } from "../types";
import { ChatProvider } from "./base";

/** Fixed poll cadence in ms (see module docs: ignore the 10 s throttle). */
const POLL_INTERVAL_MS = 1_000;
/** Give up the poll loop and reconnect after this many consecutive failures. */
const MAX_POLL_FAILURES = 5;

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/** Curated palette of distinct, readable chat colors. YouTube's live-chat API
 * sends no per-user color, so we derive one deterministically from the
 * username; the same name always gets the same color. */
const USER_COLORS = [
	"#ff7eb6",
	"#7ee8fa",
	"#ffd166",
	"#8aff80",
	"#c792ea",
	"#ff8a65",
	"#4fc3f7",
	"#aed581",
	"#ffb74d",
	"#ba68c8",
	"#4dd0e1",
	"#f06292",
	"#9ccc65",
	"#7986cb",
	"#ffca28",
	"#26a69a",
	"#e57373",
	"#64b5f6",
];

/** Stable username display color (a palette entry, hashed from the name). */
function userNameColor(username: string): string {
	let h = 0;
	for (let i = 0; i < username.length; i++) h = (h * 31 + username.charCodeAt(i)) | 0;
	return USER_COLORS[Math.abs(h) % USER_COLORS.length];
}

/** Map one chat ChatItem to the wire shape (text parts joined, emoji parts
 * rendered by their unicode/label). The `@` is dropped from the name (it is a
 * handle, not the display name YouTube shows in chat) and a stable color is
 * attached for the username display. */
function asChatMessage(item: ChatItem): ChatLive | null {
	const text = item.message
		.map((part) => ("text" in (part as object) ? (part as { text: string }).text : (part as { emojiText: string }).emojiText))
		.join("");
	const username = item.author?.name?.replace(/^@/, "") || undefined;
	return { id: item.id, username, text, ts: item.timestamp.getTime(), color: username ? userNameColor(username) : undefined };
}

export class YoutubeChatProvider extends ChatProvider {
	/** true while the poll loop for this channel is running */
	#polling = false;

	constructor(channel: string, publish: PublishFn) {
		super("youtube", channel, publish);
	}

	protected connect(): void {
		if (this.stopped || this.#polling) return;
		this.#polling = true;

		// The config value carries no `@` (normalized in the manager);
		// YouTube's handle does.
		const handle = this.channel.startsWith("@") ? this.channel : `@${this.channel}`;

		const loop = async (): Promise<void> => {
			const errText = (err: unknown): string => (err instanceof Error ? err.message : String(err));

			let options: FetchOptions | null = null;
			try {
				options = await fetchLivePage({ handle }, "live");
			} catch (err) {
				// Offline stream (NotLiveError) or transient failure — "try
				// again later".
				this.log("live page", errText(err));
				this.#onEnd();
				return;
			}

			let failures = 0;
			// The first fetched page is YouTube's buffered history (up to ~50
			// messages, minutes old) — skip it so viewers only see fresh
			// messages arriving live, then take its continuation token.
			let live = false;
			while (!this.stopped) {
				try {
					const [items, continuation] = await fetchChat(options);
					failures = 0;
					if (!continuation) {
						// Empty continuation — the stream ended.
						this.#onEnd();
						return;
					}
					options.continuation = continuation;
					if (!live) {
						live = true;
					} else {
						this.setConnected(true);
						for (const item of items) {
							const line = asChatMessage(item);
							if (!line) continue;
							this.deliver(line);
						}
					}
				} catch (err) {
					if (this.stopped) return;
					// ScrapeError means the response shape no longer parses —
					// retrying won't help until a reconnect re-resolves it.
					if (err instanceof ScrapeError) {
						this.log("scrape error", `${errText(err)} (field: ${err.field})`);
						this.#onEnd();
						return;
					}
					failures += 1;
					this.log("poll", errText(err));
					if (failures >= MAX_POLL_FAILURES) {
						this.#onEnd();
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

	protected teardown(): void {
		// The poll loop exits on its next `stopped` check.
	}

	/** End the poll loop (stream ended / unrecoverable failure) and reconnect. */
	#onEnd(): void {
		if (this.stopped) return;
		this.#polling = false;
		this.setConnected(false);
		this.scheduleReconnect();
	}
}
