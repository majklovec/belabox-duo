/**
 * Kick chat provider — Kick does not expose a direct chat websocket; chat
 * rides Pusher. Each channel is resolved to its chatroom id through
 * kick.com's public REST API, joined on Pusher's public app, and the
 * unauthenticated `chatrooms.<id>.v2` channel is subscribed; each
 * `App\Events\ChatMessageEvent` payload becomes a `kick.chat` push. The
 * subscribe handshake is capped by a timeout (a stalled handshake would
 * otherwise hang the connection forever).
 */
import type { ChatLive, PublishFn } from "../types";
import { ChatProvider } from "./base";

/** Kick's public Pusher chat app (protocol 7, anonymous join). */
const PUSHER_URL =
	"wss://ws-us2.pusher.com/app/32cbd69e4b950bf97679?protocol=7&client=js&version=8.4.0-rc2&flash=false";
/** Channel slug -> chatroom id lookup. */
const KICK_CHANNEL_API = "https://kick.com/api/v2/channels";
const RESOLVE_TIMEOUT_MS = 10_000;
/** Give up on the subscribe handshake when it does not complete in time. */
const SUBSCRIBE_TIMEOUT_MS = 10_000;

export class KickChatProvider extends ChatProvider {
	#chatroom: number | null = null;
	#ws: WebSocket | null = null;
	#subscribed = false;
	#subscribeTimer: ReturnType<typeof setTimeout> | null = null;

	constructor(channel: string, publish: PublishFn) {
		super("kick", channel, publish);
	}

	protected connect(): void {
		void resolveChatroom(this.channel)
			.then((chatroom) => {
				if (this.stopped) return;
				this.#chatroom = chatroom;
				const ws = new WebSocket(PUSHER_URL);
				this.#ws = ws;
				ws.addEventListener("message", (ev: MessageEvent) => this.#onPusherMessage(ev));
				ws.addEventListener("close", () => this.#onPusherClose());
				ws.addEventListener("error", () => ws.close());
				this.#armSubscribeTimer();
			})
			.catch((err: unknown) => {
				this.log("resolve failed", err instanceof Error ? err.message : String(err));
				this.scheduleReconnect();
			});
	}

	protected teardown(): void {
		this.#disarmSubscribeTimer();
		this.#ws?.close();
		this.#ws = null;
	}

	#onPusherMessage(ev: MessageEvent): void {
		if (!this.#chatroom || !this.#ws) return;
		const raw = typeof ev.data === "string" ? ev.data : String(ev.data);
		let msg: { event?: string; data?: unknown };
		try {
			msg = JSON.parse(raw) as { event?: string; data?: unknown };
		} catch {
			return;
		}
		switch (msg.event) {
			case "pusher:connection_established":
				this.#ws.send(
					JSON.stringify({
						event: "pusher:subscribe",
						data: { auth: "", channel: `chatrooms.${this.#chatroom}.v2` },
					}),
				);
				break;
			case "pusher:ping":
				this.#ws.send(JSON.stringify({ event: "pusher:pong", data: {} }));
				break;
			case "pusher_internal:subscription_succeeded":
				this.#disarmSubscribeTimer();
				this.#subscribed = true;
				// Re-deliver the rolling buffer so a fresh viewer can top up.
				this.setConnected(true);
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
				this.deliver(line);
				break;
			}
			default:
				break;
		}
	}

	#onPusherClose(): void {
		this.#disarmSubscribeTimer();
		if (this.#subscribed) {
			this.#subscribed = false;
			this.setConnected(false);
		}
		this.scheduleReconnect();
	}

	#armSubscribeTimer(): void {
		this.#disarmSubscribeTimer();
		this.#subscribeTimer = setTimeout(() => this.#ws?.close(), SUBSCRIBE_TIMEOUT_MS);
	}

	#disarmSubscribeTimer(): void {
		if (this.#subscribeTimer) {
			clearTimeout(this.#subscribeTimer);
			this.#subscribeTimer = null;
		}
	}
}

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

	let text =
		typeof msg.content === "string" && msg.content !== ""
			? msg.content
			: typeof msg.message === "string" && msg.message !== ""
				? msg.message
				: undefined;

	const metadata = (msg.metadata as Record<string, unknown> | undefined) ?? {};
	const originalSender = (metadata.original_sender as Record<string, unknown> | undefined) ?? {};
	const replyUsername =
		typeof originalSender.username === "string" ? originalSender.username : undefined;
	// replies get an @mention of the replied-to user prepended to the text
	if (text && replyUsername) text = `@${replyUsername} ${text}`;

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
