// tiktok-chat frontend — the dashboard widget body for the tiktok-chat channel
// module. Same rendering design as kick-chat: straight from the shared
// `tiktokLive` map (fed by the control server's dashboard websocket); no
// per-widget transport state.
import m from "mithril";
import type { ServerDashboardWidget } from "../../public/types";
import { ChannelWidgetModule, type ChannelLive } from "./types";
import { badge as badgeEl } from "../../public/ts/components/ui";
import { t } from "../../public/ts/i18n";
import "./styles.css";

/** The widget's channel name ("" when not configured) — the module owns which
 * config parameter carries it. */
function channelOf(w: ServerDashboardWidget): string {
	return (w.config?.["channel"] ?? "").trim().toLowerCase();
}

/** Card head: the channel badge (not configured, else online/disconnected). */
function badge(w: ServerDashboardWidget, live: ChannelLive): m.Vnode {
	const channel = channelOf(w);
	if (!channel) return badgeEl(t("dash.widget_not_configured"), "warn");
	return badgeEl(live.connected === false ? t("dev.badge.offline") : t("dev.badge.online"), live.connected === false ? "off" : "on");
}

/** The card body: the chat feed (newest first). */
function body(w: ServerDashboardWidget, live: ChannelLive): m.Children {
	const channel = channelOf(w);
	if (!channel) return m("p.muted", t("dash.widget_not_configured"));
	const msgs = (live.chat ?? []).map((c) =>
		m(
			"div.tiktok-chat-line",
			{ key: String(c.id) },
			c.username
				? m("span.chat-user", { style: c.color ? `color:${c.color}` : undefined }, c.username)
				: null,
			m("span.chat-text", c.text ?? ""),
		),
	);
	return msgs.length ? m("div.tiktok-chat-feed", msgs) : m("p.muted", t("tiktokchat.empty"));
}

const tiktokChatModule: ChannelWidgetModule<ServerDashboardWidget> = {
	id: "tiktok-chat",
	kind: "widget",
	configFields: ["channel"] as const,
	channelOf,
	body,
	badge,
};

export default tiktokChatModule;
