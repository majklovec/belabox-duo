/* kick-stats module UI: current viewers (large), a 20-sample ring sparkline of
 * viewer counts, follower count and a live badge. Samples arrive via `kick.stats`
 * pushes. */
import m from "mithril";
import { badge, Card } from "../../public/ts/components/ui";
import type { KickStats } from "../../public/types";
import { t } from "../../public/ts/i18n";
import { st } from "../../public/ts/device/store";
import type { BrowserModule } from "../types";

const SPARK_W = 120;
const SPARK_H = 32;
const SPARK_CAP = 20;

function sparkline(samples: number[]): m.Vnode | null {
	if (samples.length < 2) return null;
	const max = Math.max(1, ...samples);
	const points = samples
		.map((v, i) => `${((i / (samples.length - 1)) * SPARK_W).toFixed(1)},${(SPARK_H - (v / max) * SPARK_H).toFixed(1)}`)
		.join(" ");
	return m("svg.spark", { viewBox: `0 0 ${SPARK_W} ${SPARK_H}`, width: SPARK_W, height: SPARK_H, "aria-hidden": "true" },
		m("polyline", { points, fill: "none", "stroke-width": "2" }));
}

function kickStatsCard(): m.Vnode {
	const enabled = st.modules["kick-stats"]?.enabled;
	const s = st.kick.stats;
	return m(
		Card,
		{ title: t("kickstats.card") },
		!enabled ? m("p.muted", t("kickstats.disabled")) : null,
		!s ? m("p.muted", t("kickstats.waiting")) : [
			m("div.kick-stats-top",
				m("span.big", m("span.kick-viewers", s.viewers?.toLocaleString() ?? "—"), t("kickstats.viewers")),
				s.isLive ? badge(t("kickstats.live"), "on") : badge(t("kickstats.offline"), "off"),
				m("div", [
					m("span", `${t("kickstats.followers")} `),
					m("strong", (s.followers ?? 0).toLocaleString()),
				]),
			),
			s.title ? m("p.kick-title", s.title) : null,
			m("div.kick-spark", sparkline(st.kick.spark.slice(-SPARK_CAP)),
				st.kick.spark.length < 2 ? m("span.muted", t("kickstats.spark_pending")) : null),
		],
	);
}

function handleEvent(event: string, data: unknown): void {
	if (event !== "kick.stats") return;
	st.kick.stats = data as KickStats;
	st.kick.spark.push(st.kick.stats?.viewers ?? 0);
	if (st.kick.spark.length > SPARK_CAP) st.kick.spark.shift();
	m.redraw();
}

export const kickStatsModule: BrowserModule = {
	id: "kick-stats",
	title: "Kick stats",
	component: () => kickStatsCard(),
	defaultWidth: "full",
	handleEvent,
};
