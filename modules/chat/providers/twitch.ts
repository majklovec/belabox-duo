/**
 * Twitch chat provider — one IRC-over-websocket connection per channel on
 * Twitch's public relay (`wss://irc-ws.chat.twitch.tv`, anonymous
 * `justinfan` nick, no auth). CAP REQ for IRCv3 tags (color, display-name,
 * message id); every PRIVMSG becomes a `twitch.chat` push; PING/PONG keeps
 * the connection alive.
 */
import type { ChatLive, PublishFn } from "../types";
import { ChatProvider } from "./base";

/** Twitch's public IRC relay (no auth, anonymous `justinfan` nick). */
const TWITCH_WS_URL = "wss://irc-ws.chat.twitch.tv:443";

export class TwitchChatProvider extends ChatProvider {
	#ws: WebSocket | null = null;

	constructor(channel: string, publish: PublishFn) {
		super("twitch", channel, publish);
	}

	protected connect(): void {
		const ws = new WebSocket(TWITCH_WS_URL);
		this.#ws = ws;
		ws.addEventListener("open", () => {
			if (this.stopped) return;
			// Request IRCv3 tags (color, display-name, id) for PRIVMSG lines.
			ws.send("CAP REQ :twitch.tv/tags twitch.tv/commands");
			ws.send("PASS SCHMOOPIIE");
			ws.send(`NICK justinfan${(1000 + Math.floor(Math.random() * 80000)).toString(16)}`);
			ws.send(`JOIN #${this.channel}`);
			// Re-deliver the rolling buffer so a fresh viewer can top up.
			this.setConnected(true);
		});
		ws.addEventListener("message", (ev: MessageEvent) => this.#onIrcMessage(typeof ev.data === "string" ? ev.data : String(ev.data)));
		ws.addEventListener("close", () => {
			if (this.stopped) {
				this.#ws = null;
				return;
			}
			this.setConnected(false);
			this.scheduleReconnect();
		});
		ws.addEventListener("error", () => ws.close());
	}

	protected teardown(): void {
		this.#ws?.close();
		this.#ws = null;
	}

	#onIrcMessage(data: string): void {
		// One WebSocket frame can carry several IRC lines, \r\n-separated.
		for (const line of data.split("\r\n")) {
			if (!line) continue;
			// PING keeps the connection alive.
			if (line.startsWith("PING")) {
				this.#ws?.send("PONG :tmi.twitch.tv");
				continue;
			}
			if (!line.includes("PRIVMSG")) continue;
			const chatLine = asChatMessage(line);
			if (!chatLine) continue;
			this.deliver(chatLine);
		}
	}
}

/** IRCv3 tag block at the start of a line (`@a=b;c=d;rest` tag values come
 * back escaped: `\s` space, `\:` semicolon, `\\` backslash). */
function parseTags(line: string): { tags: Record<string, string>; rest: string } {
	const default_ = { tags: {} as Record<string, string>, rest: line };
	if (!line.startsWith("@")) return default_;
	const spaceIdx = line.indexOf(" ");
	if (spaceIdx === -1) return default_;
	const tags: Record<string, string> = {};
	line.slice(1, spaceIdx).split(";").forEach((pair) => {
		const eq = pair.indexOf("=");
		if (eq === -1) {
			tags[pair] = "";
		} else {
			tags[pair.slice(0, eq)] = pair.slice(eq + 1).replace(/\\s/g, " ").replace(/\\:/g, ";").replace(/\\\\/g, "\\");
		}
	});
	return { tags, rest: line.slice(spaceIdx + 1) };
}

/**
 * Map one IRC PRIVMSG line to the wire shape (message id, display name and
 * color all come from the IRCv3 tag block).
 */
function asChatMessage(raw: string): ChatLive | null {
	const { tags, rest } = parseTags(raw);
	const match = rest.match(/^:([^!]+)![^ ]+ PRIVMSG [^ ]+ :(.+)$/);
	if (!match) return null;
	const text = match[2];
	const username = tags["display-name"] || match[1];
	const color = typeof tags.color === "string" && /^#[0-9a-fA-F]{6}$/.test(tags.color) ? tags.color : undefined;
	const id = tags.id || `${username}:${text}:${Date.now()}`;
	const out: ChatLive = { id, username, text, ts: Date.now() };
	if (color) out.color = color;
	return out;
}
