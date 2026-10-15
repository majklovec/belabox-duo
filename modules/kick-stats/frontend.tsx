// kick-stats frontend — the dashboard widget for the kick-stats channel
// module. Self-contained: owns its per-channel live map, fed by the dashboard
// websocket frames it cares about (`widget.snapshot`, `kick.stats`): current
// stream info plus a line chart of viewer counts from the server-side poller.
// The core only forwards frames (`onFrame`).
import m from "mithril";
import type { ServerDashboardWidget } from "../../public/types";
import {
	ChannelWidgetModule,
	type ChannelLive,
	type StatsLive,
	type StatsSample,
	type WidgetContext,
} from "./types";
import { Badge } from "../../public/ts/components/ui";
import { t } from "../../public/ts/i18n";
import { KICK_STATS_CONFIG_FIELDS } from "./backend";
import { LineChart } from "./graph-linechart";
import "./styles.css";

/** Live kick-stats data per channel, accumulated from the dashboard websocket. */
const live = new Map<string, ChannelLive>();
const liveFor = (channel: string): ChannelLive => {
	let l = live.get(channel);
	if (!l) {
		l = {};
		live.set(channel, l);
	}
	return l;
};

/** Fold one dashboard-websocket frame into this module's live state; the kick
 * stats frames only — the chat channels' frames are ignored here. */
function onFrame(event: string, data: unknown): void {
	if (event === "widget.snapshot") {
		const snap = data as { stats?: Record<string, StatsLive | null> };
		for (const [channel, stats] of Object.entries(snap.stats ?? {}))
			liveFor(channel).stats = stats;
	} else if (event === "kick.stats") {
		const e = data as { channel?: string; stats?: StatsLive };
		if (e.channel && e.stats) liveFor(e.channel).stats = e.stats;
	}
}

/** The widget's channel name ("" when not configured) — the module owns which
 * config parameter carries it. */
function channelOf(w: ServerDashboardWidget): string {
	return (w.config?.["channel"] ?? "").trim().toLowerCase();
}

/** Card head: the stream badge (not configured, waiting, else streaming/offline). */
function badge(w: ServerDashboardWidget, _ctx: WidgetContext): m.Vnode {
	const channel = channelOf(w);
	if (!channel) return <Badge text={t("dash.widget_not_configured")} kind="warn" />;
	const s = (live.get(channel) ?? {}).stats;
	if (!s) return <Badge text={t("dash.widget_waiting")} kind="warn" />;
	return (
		<Badge text={s.isLive ? t("dev.badge.online") : t("dev.badge.offline")} kind={s.isLive ? "on" : "off"} />
	);
}

/** Stream duration, whole minutes ("1 h 23 min"). */
function durationMinutes(fromMs: number, toMs: number): string {
	const mins = Math.max(0, Math.floor((toMs - fromMs) / 60_000));
	const h = Math.floor(mins / 60);
	const m = mins % 60;
	return h > 0 ? `${h} h ${m} min` : `${m} min`;
}

/** The card body: stream info on top, the viewers line chart below. */
function body(w: ServerDashboardWidget, _ctx: WidgetContext): m.Children {
	const channel = channelOf(w);
	if (!channel) return <p class={"muted"}>{t("dash.widget_not_configured")}</p>;
	const s = (live.get(channel) ?? {}).stats;
	if (!s) return <p class={"muted"}>{t("kickstats.waiting")}</p>;
	const now = s.at;
	return (
		<div class={"kick-stats"}>
			{[
				<div class={"kick-stats-top"}>
					{[
						<span class={"big"}>
							{[
								<span class={"kick-viewers"}>{(s.viewers ?? 0).toLocaleString()}</span>,
								` ${t("kickstats.viewers")}`,
							]}
						</span>,
						s.isLive ? (
							<Badge text={t("kickstats.live")} kind="on" />
						) : (
							<Badge text={t("kickstats.offline")} kind="off" />
						),
					]}
				</div>,
				s.title ? <p class={"kick-title"}>{s.title}</p> : null,
				<div class={"kick-stats-meta"}>
					{[
						s.category ? <span>{s.category}</span> : null,
						s.startTime ? (
							<span
								class={"muted"}
							>{`${t("kickstats.start")} ${new Date(s.startTime).toLocaleString()}`}</span>
						) : null,
						s.isLive && s.startTime ? (
							<span
								class={"muted"}
							>{`${t("kickstats.duration")} ${durationMinutes(s.startTime, now)}`}</span>
						) : null,
					]}
				</div>,
				<div class={"kick-spark"}>
					{[
						s.series && s.series.length >= 2 ? (
							<LineChart
								points={s.series}
								title={`${channel} — ${t("kickstats.chart")}`}
								key={`c${s.series.length}`}
							/>
						) : (
							<span class={"muted"}>{t("kickstats.spark_pending")}</span>
						),
					]}
				</div>,
			]}
		</div>
	);
}

const kickStatsModule: ChannelWidgetModule<ServerDashboardWidget> = {
	id: "kick-stats",
	kind: "widget",
	widgetTypes: ["kick-stats"],
	defaultSize: { w: 3, h: 2 },
	configFields: KICK_STATS_CONFIG_FIELDS,
	channelOf,
	body,
	badge,
	onFrame,
};

export default kickStatsModule;
