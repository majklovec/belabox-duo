/* Interfaces card: bond selection per interface, with live srtla_send link stats matched
 * to interfaces by source IP. */
import m from "mithril";
import type { SrtlaLinkStats, Status } from "../../types";
import { badge, button, Card, type Child } from "../components/ui";
import { formatBitrate, formatSpeed, since } from "../util";
import { t } from "../i18n";
import { act, busy, st } from "./store";
import { css, cx } from "styled-system/css";

const STATS_STALE_MS = 5_000;
const LINK_COLUMNS = 7;

/** Signal-quality meter with its percentage. */
export function signal(quality?: number): Child {
	if (quality === undefined) return "—";
	return (
		<span class={css({display: "inline-flex", alignItems: "center", gap: "0.25rem"})}>
			<meter class={css({height: "0.5rem", width: "4rem"})} min={0} max={100} low={30} high={60} optimum={100} value={quality} />
			{`${quality}%`}
		</span>
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
	const cell = (child: Child, cls = "", title?: string): m.Vnode => (
		<td class={cx(css({ paddingInline: "0.5rem", paddingBlock: "0.25rem" }), cls === "num" ? css({ textAlign: "right" }) : cls === "muted" ? css({ color: "neutral" }) : undefined)} title={title}>
			{child}
		</td>
	);
	if (!l) return Array.from({ length: LINK_COLUMNS }, (_, i) => <td key={i} class={css({paddingInline: "0.5rem", paddingBlock: "0.25rem", color: "neutral"})}>—</td>);
	const share = total ? l.bitrate_bytes_per_sec / total : 0;
	return [
		cell(linkState(l), "", l.label ?? ""),
		cell(
			<span class={css({display: "inline-flex", alignItems: "center", gap: "0.25rem"})}>
				<meter
					class={css({height: "0.5rem", width: "3rem"})}
					min={0}
					max={1}
					value={share}
					title={t("dev.link_share_title", Math.round(share * 100), Math.round(l.rtt_min_ms))}
				/>
				{formatBitrate(l.bitrate_bytes_per_sec)}
			</span>,
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

const TH_CLASS = css({ paddingInline: "0.5rem", paddingBlock: "0.25rem", textAlign: "left", fontWeight: "500" });

function header(): m.Vnode {
	const th = (text: string, title?: string) => <th class={TH_CLASS} title={title}>{text}</th>;
	return (
		<thead>
			<tr>
				{th(t("dev.th.bond"))}
				{th(t("dev.th.interface"))}
				{th(t("dev.signal"))}
				{th(t("dev.th.network"))}
				{th(t("dev.th.link"))}
				{th(t("mgmt.th_bitrate"))}
				{th("RTT")}
				{th(t("dev.th.in_flight"), t("dev.th.in_flight_title"))}
				{th(t("dev.th.naks"))}
				{th(t("dev.th.loss"))}
				{th(t("dev.th.quality"))}
			</tr>
		</thead>
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
		return (
			<tr key={i.iface} class={selected.has(i.iface) ? css({ backgroundColor: "neutral/5" }) : undefined}>
				<td class={css({paddingInline: "0.5rem", paddingBlock: "0.25rem"})}>
					<input
						class="checkbox"
						type="checkbox"
						checked={selected.has(i.iface)}
						disabled={busy.has(busyKey)}
						title={t("dev.include_in_bond")}
						onchange={() => void act(busyKey, "modems.toggle", { iface: i.iface })}
					/>
				</td>
				<td class={css({paddingInline: "0.5rem", paddingBlock: "0.25rem"})}>
					{i.iface}
					{i.speed && <small class={css({color: "neutral"})}> · {formatSpeed(i.speed)}</small>}
					{sub && <span class={css({color: "neutral"})}> · {sub}</span>}
				</td>
				<td class={css({paddingInline: "0.5rem", paddingBlock: "0.25rem"})}>{signal(i.signalQuality)}</td>
				<td class={css({paddingInline: "0.5rem", paddingBlock: "0.25rem"})}>{network || "—"}</td>
				{linkCells(links.get(i.ip), total)}
			</tr>
		);
	});

	return (
		<Card
			title={t("dev.card.interfaces")}
			headActions={[
				stale && badge(t("dev.stale", since(st.statsAt)), "warn"),
				button(t("ui.reconfigure"), {
					disabled: busy.has("reconfigure"),
					onclick: () => void act("reconfigure", "reconfigure"),
				}),
			]}
		>
			<table class={css({width: "100%", fontSize: "0.875rem", lineHeight: "1.25rem"})}>
				{header()}
				<tbody>
					{rows.length
						? rows
						: <tr>
								<td colspan={4 + LINK_COLUMNS} class={css({color: "neutral"})}>{t("dev.no_interfaces")}</td>
						 </tr>}
				</tbody>
			</table>
		</Card>
	);
}
