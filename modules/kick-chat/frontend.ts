// kick-chat frontend — the dashboard widget body for the kick-chat channel
// module. Renders straight from the shared `kickLive` map (fed by the
// control server's dashboard websocket); no per-widget transport state.
import m from "mithril";
import type { ServerDashboardWidget } from "../../public/types";
import { ChannelWidgetModule } from "../widgets";
import type { ChannelLive } from "../types";
import { badge as badgeEl } from "../../public/ts/components/ui";
import { t } from "../../public/ts/i18n";
import "./styles.css";

/** Card head: the channel badge (not configured, else online/disconnected). */
function badge(w: ServerDashboardWidget, live: ChannelLive): m.Vnode {
	const channel = w.config?.channel?.trim();
	if (!channel) return badgeEl(t("dash.widget_not_configured"), "warn");
	return badgeEl(live.connected === false ? t("dev.badge.offline") : t("dev.badge.online"), live.connected === false ? "off" : "on");
}

/** One piece of a parsed chat line: a text run or an embedded Kick emote. */
type ChatSegment = { kind: "text"; value: string } | { kind: "emote"; id: string; name: string };

/** Kick embeds emotes as `[emote:<id>:<name>]`; split a message into runs. */
const EMOTE_RE = /\[emote:(\d+):([^\]]*)\]/g;
function parseSegments(text: string): ChatSegment[] {
	const out: ChatSegment[] = [];
	let last = 0;
	for (const match of text.matchAll(EMOTE_RE)) {
		const idx = match.index ?? 0;
		if (idx > last) out.push({ kind: "text", value: text.slice(last, idx) });
		out.push({ kind: "emote", id: match[1], name: match[2].trim() });
		last = idx + match[0].length;
	}
	if (last < text.length) out.push({ kind: "text", value: text.slice(last) });
	return out;
}

// Emote ids whose image 404'd — shown as a plain name afterwards instead of a
// broken image. Removing a Mithril-owned node directly desyncs reconciliation.
const failedEmotes = new Set<string>();

/** A message body: text runs plus `img` emotes sized to the line's font. */
function lineSegments(text: string): m.Children {
	return parseSegments(text).map((s, i) =>
		s.kind === "text"
			? m("span", { key: i }, s.value)
			: failedEmotes.has(s.id)
				? m("span.chat-emote-name", { key: i }, s.name)
				: m("img.chat-emote", {
						key: i,
						src: `https://files.kick.com/emotes/${s.id}/fullsize`,
						alt: s.name,
						loading: "lazy",
						onerror: () => {
							failedEmotes.add(s.id);
							m.redraw();
						},
					}),
	);
}

/** The card body: the chat feed (newest first). */
function body(w: ServerDashboardWidget, live: ChannelLive): m.Children {
	const channel = w.config?.channel?.trim();
	if (!channel) return m("p.muted", t("dash.widget_not_configured"));
	const msgs = (live.chat ?? []).map((c) =>
		m(
			"div.kick-chat-line",
			{ key: String(c.id) },
			c.username
				? m("span.chat-user", { style: c.color ? `color:${c.color}` : undefined }, c.username)
				: null,
			m("span.chat-text", lineSegments(c.text ?? "")),
		),
	);
	return msgs.length ? m("div.kick-chat-feed", msgs) : m("p.muted", t("kickchat.empty"));
}

export const kickChatModule: ChannelWidgetModule<ServerDashboardWidget> = {
	id: "kick-chat",
	configFields: ["channel", "token"],
	body,
	badge,
};
