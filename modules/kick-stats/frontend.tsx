// kick-stats frontend — the dashboard widget body for the kick-stats channel
// module. Renders straight from the shared `kickLive` map (fed by the
// control server's dashboard websocket): current stream info plus a line
// chart of viewer counts collected by the server-side poller.
import m from "mithril";
import type { ServerDashboardWidget } from "../../public/types";
import { ChannelWidgetModule, type ChannelLive, type StatsSample } from "./types";
import { badge as badgeEl } from "../../public/ts/components/ui";
import { t } from "../../public/ts/i18n";
import { KICK_STATS_CONFIG_FIELDS } from "./backend";
import { pum } from "../../public/ts/jsx";
import { LineChart } from "./graph-linechart";
import { css, cx } from "styled-system/css";

const LineChartView = pum(LineChart);

/** The widget's channel name ("" when not configured) — the module owns which
 * config parameter carries it. */
function channelOf(w: ServerDashboardWidget): string {
	return (w.config?.["channel"] ?? "").trim().toLowerCase();
}

/** Card head: the stream badge (not configured, waiting, else streaming/offline). */
function badge(w: ServerDashboardWidget, live: ChannelLive): m.Vnode {
	const channel = channelOf(w);
	if (!channel) return badgeEl(t("dash.widget_not_configured"), "warn");
	const s = live.stats;
	if (!s) return badgeEl(t("dash.widget_waiting"), "warn");
	return badgeEl(s.isLive ? t("dev.badge.online") : t("dev.badge.offline"), s.isLive ? "on" : "off");
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
	const channel = channelOf(w);
	if (!channel) return <p class={css({color: "neutral"})}>{t("dash.widget_not_configured")}</p>;
	const s = live.stats;
	if (!s) return <p class={css({color: "neutral"})}>{t("kickstats.waiting")}</p>;
	const now = s.at;
	return (
		<div class={cx("kick-stats", css({display: "flex", height: "100%", flexDirection: "column", gap: "0.5rem"}))}>
			<div class={css({display: "flex", alignItems: "center", gap: "0.5rem"})}>
				<span class={css({fontSize: "1.875rem", lineHeight: "2.25rem", fontWeight: "600"})}>
					{(s.viewers ?? 0).toLocaleString()} {t("kickstats.viewers")}
				</span>
				{s.isLive ? badgeEl(t("kickstats.live"), "on") : badgeEl(t("kickstats.offline"), "off")}
			</div>
			{s.title ? <p class={css({overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", fontSize: "0.875rem", lineHeight: "1.25rem"})}>{s.title}</p> : null}
			<div class={css({display: "flex", flexWrap: "wrap", columnGap: "0.75rem", rowGap: "0.25rem", fontSize: "0.75rem", lineHeight: "1rem"})}>
				{s.category ? <span>{s.category}</span> : null}
				{s.startTime ? (
					<span class={css({color: "neutral"})}>{`${t("kickstats.start")} ${new Date(s.startTime).toLocaleString()}`}</span>
				) : null}
				{s.isLive && s.startTime ? (
					<span class={css({color: "neutral"})}>{`${t("kickstats.duration")} ${durationMinutes(s.startTime, now)}`}</span>
				) : null}
			</div>
			<div class={css({minHeight: "0px", flex: "1"})}>
				{s.series && s.series.length >= 2 ? (
					<LineChartView key={`c${s.series.length}`} points={s.series} title={`${channel} — ${t("kickstats.chart")}`} />
				) : (
					<span class={css({color: "neutral"})}>{t("kickstats.spark_pending")}</span>
				)}
			</div>
		</div>
	);
}

const kickStatsModule: ChannelWidgetModule<ServerDashboardWidget> = {
	id: "kick-stats",
	kind: "widget",
	configFields: KICK_STATS_CONFIG_FIELDS,
	channelOf,
	body,
	badge,
};

export default kickStatsModule;
