// kick-chat frontend — the dashboard widget body for the kick-chat channel
// module. Renders straight from the shared `kickLive` map (fed by the
// control server's dashboard websocket); no per-widget transport state.
import m from "mithril";
import type { ServerDashboardWidget } from "../../public/types";
import { ChannelWidgetModule } from "../widgets";
import type { ChannelLive } from "../types";
import { badge } from "../../public/ts/components/ui";
import { t } from "../../public/ts/i18n";
import "./styles.css";

/** The card body: online badge plus the chat feed (newest first). */
function body(w: ServerDashboardWidget, live: ChannelLive): m.Children {
	const channel = w.config?.channel?.trim();
	if (!channel) return [badge(t("dash.widget_not_configured"), "warn")];
	const msgs = (live.chat ?? []).map((c) =>
		m(
			"div.kick-chat-line",
			{ key: String(c.id) },
			c.username ? m("span.chat-user", c.username) : null,
			m("span.chat-text", c.text ?? ""),
		),
	);
	return [
		badge(live.connected === false ? t("dev.badge.offline") : t("dev.badge.online"), live.connected === false ? "off" : "on"),
		msgs.length ? m("div.kick-chat-feed", msgs) : m("p.muted", t("kickchat.empty")),
	];
}

export const kickChatModule: ChannelWidgetModule<ServerDashboardWidget> = {
	id: "kick-chat",
	configFields: ["channel", "token"],
	body,
};
