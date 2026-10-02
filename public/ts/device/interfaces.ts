/* Interfaces card: bond selection per interface, with live srtla_send link stats matched
 * to interfaces by source IP. */
import m from "mithril";
import type { SrtlaLinkStats, Status } from "../../types";
import { badge, button, Card, type Child } from "../components/ui";
import { formatBitrate, formatSpeed, since } from "../util";
import { t } from "../i18n";
import { act, busy, st } from "./store";

const STATS_STALE_MS = 5_000;
const LINK_COLUMNS = 7;

/** Signal-quality meter with its percentage. */
export function signal(quality?: number): Child {
	if (quality === undefined) return "—";
	return m(
		"span",
		m("meter", { min: 0, max: 100, low: 30, high: 60, optimum: 100, value: quality }),
		` ${quality}%`,
	);
}

function linkState(l: SrtlaLinkStats): m.Vnode {
	if (l.timed_out) return badge(t("dev.link_timed_out"), "off");
	if (!l.connected) return badge(t("dev.control_connecting"), "warn");
	if (l.stall_gated) return badge(t("dev.link_stalled"), "warn");
	if (l.weak) return m("span", { title: l.weak_reason ?? "" }, badge(t("dev.link_weak"), "warn"));
	return badge(l.sole_carrier ? t("dev.link_sole") : t("dev.link_up"), "on");
}

function linkCells(l: SrtlaLinkStats | undefined, total: number): m.Vnode[] {
	const cell = (child: Child, cls = "", title?: string): m.Vnode =>
		m("td", { class: `link-col ${cls}`.trim(), title }, child);
	if (!l) return Array.from({ length: LINK_COLUMNS }, () => cell("—", "muted"));
	const share = total ? l.bitrate_bytes_per_sec / total : 0;
	return [
		cell(linkState(l), "", l.label ?? ""),
		cell(
			m(
				"span",
				m("meter.share", {
					min: 0,
					max: 1,
					value: share,
					title: t("dev.link_share_title", Math.round(share * 100), Math.round(l.rtt_min_ms)),
				}),
				formatBitrate(l.bitrate_bytes_per_sec),
			),
			"num",
		),
		cell(l.connected ? `${Math.round(l.rtt_ms)} ms` : "—", "num", t("dev.link_min_rtt", Math.round(l.rtt_min_ms))),
		cell(`${l.in_flight} / ${l.window}`, "num"),
		cell(l.nak_count, "num"),
		cell(`${((l.cc_loss_permille ?? 0) / 10).toFixed(1)}%`, "num"),
		cell(
			l.quality_multiplier !== undefined ? `×${l.quality_multiplier.toFixed(2)}` : "—",
			"num",
			l.base_score !== undefined ? t("dev.link_score", l.base_score) : "",
		),
	];
}

function header(): m.Vnode {
	const th = (text: string, title?: string) => m("th.link-col", { title }, text);
	return m(
		"thead",
		m(
			"tr",
			m("th", t("dev.th.bond")),
			m("th", t("dev.th.interface")),
			m("th", t("dev.signal")),
			m("th", t("dev.th.network")),
			th(t("dev.th.link")),
			th(t("mgmt.th_bitrate")),
			th("RTT"),
			th(t("dev.th.in_flight"), t("dev.th.in_flight_title")),
			th(t("dev.th.naks")),
			th(t("dev.th.loss")),
			th(t("dev.th.quality")),
		),
	);
}

export function interfacesCard(status: Status): m.Vnode {
	const selected = new Set(status.selected.map((i) => i.iface));
	const live = st.stats;
	const stale = !!live && !!st.statsAt && Date.now() - st.statsAt > STATS_STALE_MS;
	const links = new Map((live?.links ?? []).map((l) => [l.ip, l]));
	const total = live?.links.reduce((sum, l) => sum + (l.bitrate_bytes_per_sec || 0), 0) ?? 0;

	const rows = status.interfaces.map((i) => {
		const sub = [i.cidr, i.modemIndex !== undefined ? t("dev.iface_modem", i.modemIndex) : null]
			.filter(Boolean)
			.join(" · ");
		const network = [i.operatorName, i.accessTech].filter(Boolean).join(" · ");
		const busyKey = `iface:${i.iface}`;
		return m(
			"tr",
			{ key: i.iface, class: selected.has(i.iface) ? "selected" : "" },
			m(
				"td",
				m("input", {
					type: "checkbox",
					checked: selected.has(i.iface),
					disabled: busy.has(busyKey),
					title: t("dev.include_in_bond"),
					onchange: () => void act(busyKey, "modems.toggle", { iface: i.iface }),
				}),
			),
			m(
				"td",
				i.iface,
				i.speed ? m("small.muted", ` · ${formatSpeed(i.speed)}`) : null,
				sub ? m("span.iface-sub.muted", sub) : null,
			),
			m("td", signal(i.signalQuality)),
			m("td", network || "—"),
			linkCells(links.get(i.ip), total),
		);
	});

	return m(
		Card,
		{
			title: t("dev.card.interfaces"),
			headActions: [
				stale && badge(t("dev.stale", since(st.statsAt)), "warn"),
				button(t("ui.reconfigure"), {
					disabled: busy.has("reconfigure"),
					onclick: () => void act("reconfigure", "reconfigure"),
				}),
			],
		},
		m(
			"table",
			{ class: live ? "" : "no-stats" },
			header(),
			rows.length ? rows : m("tr", m("td", { colspan: 4 + LINK_COLUMNS, class: "muted" }, t("dev.no_interfaces"))),
		),
	);
}
