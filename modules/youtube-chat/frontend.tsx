// youtube-chat frontend — the dashboard widget for the youtube-chat channel
// module. Self-contained: owns its per-channel live map, fed by the dashboard
// websocket frames it cares about (`widget.snapshot`, `youtube.chat`); no
// per-widget transport state. The core only forwards frames (`onFrame`).
import m from "mithril";
import type { ServerDashboardWidget } from "../../public/types";
import {
	ChannelWidgetModule,
	ChatLive,
	type ChannelLive,
	type WidgetContext,
} from "./types";
import { Badge } from "../../public/ts/components/ui";
import { t } from "../../public/ts/i18n";
import "./styles.css";

/** Live chat buffer size per channel — matches the backend rolling-buffer
 * HISTORY_CAP, so the widget keeps everything the hub sends. */
const CAP = 500;

/** Live youtube-chat data per channel, accumulated from the dashboard websocket. */
const live = new Map<string, ChannelLive>();
const liveFor = (channel: string): ChannelLive => {
	let l = live.get(channel);
	if (!l) {
		l = { chat: [] };
		live.set(channel, l);
	}
	return l;
};

/** Fold one dashboard-websocket frame into this module's live state; the
 * youtube chat frames only — the other channels' frames are ignored here. */
function onFrame(event: string, data: unknown): void {
	if (event === "widget.snapshot") {
		const snap = data as { youtubeChat?: Record<string, { connected?: boolean; messages?: ChatLive[] }> };
		for (const [channel, c] of Object.entries(snap.youtubeChat ?? {})) {
			const l = liveFor(channel);
			l.connected = c.connected;
			l.chat = (c.messages ?? []).slice(0, CAP);
		}
	} else if (event === "youtube.chat") {
		const e = data as
			| { channel?: string; message: ChatLive }
			| { channel?: string; reconnect: boolean; messages: ChatLive[] }
			| { channel?: string; disconnected: boolean };
		if (!e.channel) return;
		const l = liveFor(e.channel);
		if ("message" in e) l.chat = [e.message, ...(l.chat ?? [])].slice(0, CAP);
		else if ("messages" in e) l.chat = e.messages.slice(0, CAP);
		else l.connected = false;
	}
}

/** The widget's channel name ("" when not configured) — the module owns which
 * config parameter carries it. */
function channelOf(w: ServerDashboardWidget): string {
	return (w.config?.["channel"] ?? "").trim().toLowerCase();
}

/** Card head: the channel badge (not configured, else online/disconnected). */
function badge(w: ServerDashboardWidget, _ctx: WidgetContext): m.Vnode {
	const channel = channelOf(w);
	if (!channel) return <Badge text={t("dash.widget_not_configured")} kind="warn" />;
	const l = live.get(channel) ?? {};
	return (
		<Badge
			text={l.connected === false ? t("dev.badge.offline") : t("dev.badge.online")}
			kind={l.connected === false ? "off" : "on"}
		/>
	);
}

/** The card body: the chat feed (newest first). */
function body(w: ServerDashboardWidget, _ctx: WidgetContext): m.Children {
	const channel = channelOf(w);
	if (!channel) return <p class={"muted"}>{t("dash.widget_not_configured")}</p>;
	const l = live.get(channel) ?? { chat: [] };
	const msgs = (l.chat ?? []).map((c) => (
		<div class={"youtube-chat-line"} key={String(c.id)}>
			{c.username ? (
				<span class={"chat-user"} style={c.color ? `color:${c.color}` : undefined}>
					{c.username}
				</span>
			) : null}
			<span class={"chat-text"}>{c.text ?? ""}</span>
		</div>
	));
	return msgs.length ? (
		<div class={"youtube-chat-feed"}>{msgs}</div>
	) : (
		<p class={"muted"}>{t("youtubechat.empty")}</p>
	);
}

const youtubeChatModule: ChannelWidgetModule<ServerDashboardWidget> = {
	id: "youtube-chat",
	kind: "widget",
	widgetTypes: ["youtube-chat"],
	defaultSize: { w: 3, h: 3 },
	configFields: ["channel"] as const,
	channelOf,
	body,
	badge,
	onFrame,
};

export default youtubeChatModule;
