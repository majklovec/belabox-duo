// youtube-chat frontend — the dashboard widget body for the youtube-chat
// channel module. Same rendering design as kick-chat: straight from the shared
// `youtubeLive` map (fed by the control server's dashboard websocket); no
// per-widget transport state.
import m from "mithril";
import type { ServerDashboardWidget } from "../../public/types";
import { ChannelWidgetModule, type ChannelLive } from "./types";
import { badge as badgeEl } from "../../public/ts/components/ui";
import { t } from "../../public/ts/i18n";
import { css } from "styled-system/css";

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
	if (!channel) return <p class={css({color: "neutral"})}>{t("dash.widget_not_configured")}</p>;
	const msgs = (live.chat ?? []).map((c) => (
		<div key={String(c.id)} class={css({display: "flex", gap: "0.5rem", borderBottomWidth: "1px", borderColor: "white/5", paddingInline: "0.5rem", paddingBlock: "0.25rem", fontSize: "0.875rem", lineHeight: "1.25rem"})}>
			{c.username && (
				<span class={css({flexShrink: "0", fontWeight: "600"})} style={{ color: c.color }}>
					{c.username}
				</span>
			)}
			<span class={css({minWidth: "0px", overflowWrap: "break-word"})}>{c.text ?? ""}</span>
		</div>
	));
	return msgs.length ? <div class={css({display: "flex", height: "100%", flexDirection: "column", overflowY: "auto"})}>{msgs}</div> : <p class={css({color: "neutral"})}>{t("youtubechat.empty")}</p>;
}

const youtubeChatModule: ChannelWidgetModule<ServerDashboardWidget> = {
	id: "youtube-chat",
	kind: "widget",
	configFields: ["channel"] as const,
	channelOf,
	body,
	badge,
};

export default youtubeChatModule;
