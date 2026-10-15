/**
 * TikTok chat provider — one tiktok-live-connector connection per channel
 * (TikTok chat is public, no auth). The connector has no built-in
 * auto-reconnect, so the provider owns the reconnection loop (backoff from
 * the base class); `fetchRoomId` can hang (offline room, slow CDN), so each
 * attempt is capped by a connect timeout.
 */
import { ControlEvent, TikTokLiveConnection, WebcastEvent } from "tiktok-live-connector";
import type { ChatLive, PublishFn } from "../types";
import { ChatProvider } from "./base";

/** Max ms to wait for fetchRoomId (signs in to get the room id) before giving
 * up this attempt and reconnecting. */
const CONNECT_TIMEOUT_MS = 15_000;

export class TiktokChatProvider extends ChatProvider {
	#conn: TikTokLiveConnection | null = null;
	#connectTimer: ReturnType<typeof setTimeout> | null = null;

	constructor(channel: string, publish: PublishFn) {
		super("tiktok", channel, publish);
	}

	protected connect(): void {
		const conn = new TikTokLiveConnection(`@${this.channel}`, { processInitialData: false });
		this.#conn = conn;
		conn.on(WebcastEvent.CHAT, (raw: unknown) => {
			if (this.stopped || !this.connected) return;
			const line = asChatMessage(raw);
			if (!line) return;
			this.deliver(line);
		});
		conn.on(ControlEvent.CONNECTED, () => {
			if (this.stopped) return;
			this.#disarmConnectTimer();
			// Re-deliver the rolling buffer so a fresh viewer can top up.
			this.setConnected(true);
		});
		conn.on(ControlEvent.DISCONNECTED, (reason: unknown) => {
			if (this.stopped) return;
			if (reason && typeof reason === "object" && "message" in reason) {
				this.log("disconnected", String(reason.message));
			}
			this.setConnected(false);
			this.scheduleReconnect();
		});
		conn.on(ControlEvent.ERROR, (err: unknown) => {
			if (this.stopped) return;
			this.log(
				"error",
				err instanceof Error ? err.message :
				err && typeof err === "object" ? JSON.stringify(err) : String(err),
			);
		});
		// fetchRoomId can hang (offline room, slow CDN) — cap the attempt.
		this.#connectTimer = setTimeout(() => this.#onConnectFail("connect timeout"), CONNECT_TIMEOUT_MS);
		void conn.connect().catch((err: unknown) => {
			this.log("connect", err instanceof Error ? err.message : String(err));
			this.#onConnectFail("connect failed");
		});
	}

	protected teardown(): void {
		this.#disarmConnectTimer();
		this.#conn?.disconnect();
		this.#conn = null;
	}

	#onConnectFail(reason: string): void {
		this.#disarmConnectTimer();
		if (this.stopped) {
			this.#conn = null;
			return;
		}
		this.setConnected(false);
		this.#conn?.disconnect();
		this.#conn = null;
		this.scheduleReconnect();
	}

	#disarmConnectTimer(): void {
		if (this.#connectTimer) {
			clearTimeout(this.#connectTimer);
			this.#connectTimer = null;
		}
	}
}

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
