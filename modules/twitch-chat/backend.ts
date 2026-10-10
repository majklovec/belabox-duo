/*
 * twitch-chat backend — the server-side Twitch channel hub. The twitch-chat
 * dashboard widgets are device-independent, so the control server keeps one
 * IRC-over-websocket connection per channel here (Twitch chat is public; no
 * auth — anonymous `justinfan` nick) and pushes `twitch.chat` events (tagged
 * with the channel) to dashboard websocket subscribers. One instance serves
 * all chat widgets.
 *
 * Each channel joins `wss://irc-ws.chat.twitch.tv` with CAP REQ for IRCv3
 * tags (color, display-name, message id), and every PRIVMSG becomes a
 * `twitch.chat` push. PING/PONG keeps the connection alive; the rolling
 * history keeps reconnections from re-sending, and the `seen` set dedupes
 * message ids across reconnects.
 */
import { eventFrame, type ChatLive, type ChannelSpecs, type PublishFn } from "./types";

/** Twitch's public IRC relay (no auth, anonymous `justinfan` nick). */
const TWITCH_WS_URL = "wss://irc-ws.chat.twitch.tv:443";
const HISTORY_CAP = 500;
const RECONNECT_BASE_MS = 1_000;
const RECONNECT_MAX_MS = 30_000;

/** twitch.snapshot: per-channel {connected, most recent messages, newest first}. */
export interface ChatSnapshot {
	[channel: string]: { connected: boolean; messages: ChatLive[] };
}

/** twitch-chat widget's configurable parameters (single source for the server
 * validation and the frontend editor). */
export const TWITCH_CHAT_CONFIG_FIELDS = ["channel"] as const;

/** Channel-hub spec from one widget's config (null when no channel set). */
export function twitchChatSpecFromConfig(config: Record<string, string> | undefined): string | null {
	const name = (config?.["channel"] ?? "").trim().toLowerCase();
	return name || null;
}

type ChatChannelState = {
	channel: string;
	ws: WebSocket | null;
	stopped: boolean;
	connected: boolean;
	attempt: number;
	reconnectTimer: ReturnType<typeof setTimeout> | null;
	/** most recent messages, newest first */
	history: ChatLive[];
	/** recent message ids, deduped across reconnects */
	seen: Set<string>;
};

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

/**
 * State manager for twitch-chat channels. `sync(specs)` starts channels not
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
			ws: null,
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
		state.ws?.close();
		state.ws = null;
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

	/** Rolling history (newest first) per channel plus socket state. */
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
		const ws = new WebSocket(TWITCH_WS_URL);
		state.ws = ws;
		ws.addEventListener("open", () => {
			if (state.stopped) return;
			// Request IRCv3 tags (color, display-name, id) for PRIVMSG lines.
			ws.send("CAP REQ :twitch.tv/tags twitch.tv/commands");
			ws.send("PASS SCHMOOPIIE");
			ws.send(`NICK justinfan${(1000 + Math.floor(Math.random() * 80000)).toString(16)}`);
			ws.send(`JOIN #${state.channel}`);
			const was = state.connected;
			state.connected = true;
			state.attempt = 0;
			// Re-deliver the rolling buffer so a fresh viewer can top up.
			if (!was) this.#publish(eventFrame("twitch.chat", { channel: state.channel, reconnect: true, messages: state.history }));
		});
		ws.addEventListener("message", (ev: MessageEvent) => this.#onIrcMessage(state, typeof ev.data === "string" ? ev.data : String(ev.data)));
		ws.addEventListener("close", () => {
			if (state.stopped) {
				state.ws = null;
				return;
			}
			const was = state.connected;
			state.connected = false;
			if (was) this.#publish(eventFrame("twitch.chat", { channel: state.channel, disconnected: true }));
			this.#scheduleReconnect(state);
		});
		ws.addEventListener("error", () => ws.close());
	}

	#onIrcMessage(state: ChatChannelState, data: string): void {
		// One WebSocket frame can carry several IRC lines, \r\n-separated.
		for (const line of data.split("\r\n")) {
			if (!line) continue;
			// PING keeps the connection alive.
			if (line.startsWith("PING")) {
				state.ws?.send("PONG :tmi.twitch.tv");
				continue;
			}
			if (!line.includes("PRIVMSG")) continue;
			const chatLine = asChatMessage(line);
			if (!chatLine) continue;
			const key = String(chatLine.id);
			if (state.seen.has(key)) continue;
			state.seen.add(key);
			state.history.unshift(chatLine);
			if (state.history.length > HISTORY_CAP) state.history.length = HISTORY_CAP;
			// Shed ids of messages evicted from the buffer (newest first, so the
			// tail is oldest) to keep `seen` bounded.
			while (state.seen.size > HISTORY_CAP * 2) {
				const oldest = state.history.pop();
				if (oldest) state.seen.delete(String(oldest.id));
			}
			this.#publish(eventFrame("twitch.chat", { channel: state.channel, message: chatLine }));
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

/** Widget registration (the backend registry's hub wiring); the core reaches
 * this module only through it, no per-module imports in the core. */
export default {
	id: "twitch-chat",
	kind: "widget" as const,
	title: "Twitch Chat",
	hub: {
		widgetType: "twitch-chat",
		snapshotKey: "twitchChat",
		configFields: TWITCH_CHAT_CONFIG_FIELDS,
		channelSpec: twitchChatSpecFromConfig,
		create: (publish: PublishFn): ChatChannelManager => new ChatChannelManager(publish),
	},
};
