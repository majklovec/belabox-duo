// kick-stats frontend — the dashboard widget body for the kick-stats channel
// module. Renders straight from the shared `kickLive` map (fed by the
// control server's dashboard websocket); no per-widget transport state.
import m from "mithril";
import type { ServerDashboardWidget } from "../../public/types";
import { ChannelWidgetModule } from "../widgets";
import type { ChannelLive } from "../types";
import { badge, widgetTable, type Child } from "../../public/ts/components/ui";
import { t } from "../../public/ts/i18n";
import "./styles.css";

/** The card body: live badge (streaming/offline) plus the stats table. */
function body(w: ServerDashboardWidget, live: ChannelLive): m.Children {
	const channel = w.config?.channel?.trim();
	if (!channel) return [badge(t("dash.widget_not_configured"), "warn")];
	const s = live.stats;
	if (!s) return [badge(t("dash.widget_waiting"), "warn")];
	const rows: [string, Child][] = [
		[t("kickstats.viewers"), String(s.viewers ?? "—")],
		[t("kickstats.followers"), String(s.followers ?? "—")],
		[t("kickstats.live"), s.isLive ? badge(t("dev.badge.streaming"), "on") : badge(t("dev.badge.stopped"), "off")],
	];
	if (s.title) rows.push([t("kickstats.title"), s.title]);
	return [
		badge(s.isLive ? t("dev.badge.streaming") : t("dev.badge.offline"), s.isLive ? "on" : "off"),
		widgetTable(rows),
	];
}

export const kickStatsModule: ChannelWidgetModule<ServerDashboardWidget> = {
	id: "kick-stats",
	configFields: ["channel"],
	body,
};
