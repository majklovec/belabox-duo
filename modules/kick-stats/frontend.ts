// kick-stats frontend — the dashboard widget body for the kick-stats channel
// module. Renders straight from the shared `kickLive` map (fed by the
// control server's dashboard websocket): current stream info plus a line
// chart of viewer counts collected by the server-side poller.
import m from "mithril";
import type { ServerDashboardWidget } from "../../public/types";
import { ChannelWidgetModule } from "../widgets";
import type { ChannelLive, StatsSample } from "../types";
import { badge as badgeEl } from "../../public/ts/components/ui";
import { t } from "../../public/ts/i18n";
import { LineChart } from "./graph-linechart";
import "./styles.css";

/** Card head: the stream badge (not configured, waiting, else streaming/offline). */
function badge(w: ServerDashboardWidget, live: ChannelLive): m.Vnode {
	const channel = w.config?.channel?.trim();
	if (!channel) return badgeEl(t("dash.widget_not_configured"), "warn");
	const s = live.stats;
	if (!s) return badgeEl(t("dash.widget_waiting"), "warn");
	return badgeEl(s.isLive ? t("dev.badge.streaming") : t("dev.badge.offline"), s.isLive ? "on" : "off");
}


/** Stream duration, whole minutes ("1 h 23 min"). */
function durationMinutes(fromMs: number, toMs: number): string {
	const mins = Math.max(0, Math.floor((toMs - fromMs) / 60_000));
	const h = Math.floor(mins / 60);
	const m = mins % 60;
	return h > 0 ? `${h} h ${m} min` : `${m} min`;
}

/** The card body: stream info on top, the viewers line chart below. */
function body(w: ServerDashboardWidget, live: ChannelLive): m.Children {
	const channel = w.config?.channel?.trim();
	if (!channel) return m("p.muted", t("dash.widget_not_configured"));
	const s = live.stats;
	if (!s) return m("p.muted", t("kickstats.waiting"));
	const now = s.at;
	return m("div.kick-stats", [
		m("div.kick-stats-top", [
			m("span.big", [m("span.kick-viewers", (s.viewers ?? 0).toLocaleString()), ` ${t("kickstats.viewers")}`]),
			s.isLive ? badgeEl(t("kickstats.live"), "on") : badgeEl(t("kickstats.offline"), "off"),
		]),
		s.title ? m("p.kick-title", s.title) : null,
		m("div.kick-stats-meta", [
			s.category ? m("span", s.category) : null,
			s.startTime ? m("span.muted", `${t("kickstats.start")} ${new Date(s.startTime).toLocaleString()}`) : null,
			(s.isLive && s.startTime) ? m("span.muted", `${t("kickstats.duration")} ${durationMinutes(s.startTime, now)}`) : null,
		]),
		m("div.kick-spark", [
			(s.series && s.series.length >= 2)
				? m(LineChart, { points: s.series, title: `${channel} — ${t("kickstats.chart")}`, key: `c${s.series.length}` })
				: m("span.muted", t("kickstats.spark_pending")),
		]),
	]);
}

export const kickStatsModule: ChannelWidgetModule<ServerDashboardWidget> = {
	id: "kick-stats",
	configFields: ["channel"],
	body,
	badge,
};
