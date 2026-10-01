/* Control server device list — a Mithril view of a polling fetch every few seconds. */
import m from "mithril";
import { t } from "./i18n";
import { Card, Page, badge, type Child } from "./components/ui";
import { formatBitrate, since } from "./dom";
import { icon, roleTag } from "./icons";
import type { DeviceSummary } from "../types";

const REFRESH_MS = 3_000;
const COLUMNS = 9;

interface UiState {
	connText: string;
	connKind: "" | "on" | "off" | "warn";
	devices: DeviceSummary[] | null; // null = before the first fetch landed
}

const state: UiState = { connText: t("mgmt.loading"), connKind: "off", devices: null };

/** Live stream state, mirroring the device page's encoder / srtla_send badges. */
function streamState(d: DeviceSummary): Child {
	if (!d.online) return "—";
	const s = d.srtla;
	const e = d.encoder;
	if (d.role === "encoder" || d.role === "combined") {
		if (!e) return "—";
		if (!e.running) return badge(t("dev.badge.stopped"), "off");
		if (d.role === "combined" && !s?.running) return badge(t("dev.badge.srtla_send_down"), "warn");
		if (!e.pid && e.restarts) return badge(t("dev.badge.restarting"), "warn");
	} else if (!s?.running) {
		return badge(t("dev.badge.stopped"), "off");
	}
	if (d.activeLinks === 0) return badge(t("dev.badge.no_links"), "warn");
	return badge(t("dev.badge.live"), "on");
}

function bitrate(d: DeviceSummary): Child {
	const live = d.online && d.bitrate !== undefined ? formatBitrate(d.bitrate) : null;
	const max = d.maxBitrate !== undefined ? t("dev.max_value", formatBitrate(d.maxBitrate * 125)) : null;
	if (live && max) return m("span", null, live, " / ", m("span.muted", null, max));
	return live ?? max ?? "—";
}

function links(d: DeviceSummary): Child {
	return d.online && d.totalLinks !== undefined ? `${d.activeLinks ?? 0}/${d.totalLinks}` : "—";
}

function row(d: DeviceSummary): m.Vnode {
	const s = d.srtla;
	const e = d.encoder;
	const hasEncoder = d.role === "encoder" || d.role === "combined";
	const hasRelay = d.role !== "encoder";
	return m(
		"tr",
		null,
		// The dot wears the device's header color and beats while the link is up;
		// the uuid is stable, the hostname is the display name (shown when present)
		m(
			"td",
			m(
				"a.device",
				{ href: `d/${encodeURIComponent(d.id)}/`, title: d.id },
				m("span.device-dot", { class: d.online ? "online" : "", style: d.color ? `background:${d.color};color:${d.color}` : "" }),
				d.hostname || d.id,
			),
		),
		m("td.muted", d.role ? roleTag(d.role) : "—"),
		m("td", d.online ? badge(t("dev.badge.online"), "on") : badge(t("dev.badge.offline"), "off")),
		m("td", d.online ? since(d.connectedAt) : t("mgmt.last_seen", since(d.lastSeen))),
		m("td", streamState(d)),
		m("td", bitrate(d)),
		m("td", links(d)),
		m(
			"td",
			hasEncoder && e
				? e.running
					? badge(e.config?.pipeline ?? t("dev.badge.streaming"), "on")
					: badge(t("dev.badge.stopped"), "warn")
				: "—",
		),
		m(
			"td",
			hasRelay && s ? (s.running ? badge(`→ ${s.remoteHost}:${s.remotePort}`, "on") : badge(t("dev.badge.stopped"), "warn")) : "—",
		),
	);
}

async function refresh(): Promise<void> {
	try {
		const res = await fetch("api/devices", { cache: "no-store" });
		if (!res.ok) throw new Error(`HTTP ${res.status}`);
		const list = (await res.json()) as DeviceSummary[];
		const online = list.filter((d) => d.online).length;
		state.devices = list;
		state.connText = t("dev.badge.online_count", online, list.length);
		state.connKind = online ? "on" : "warn";
	} catch (err) {
		state.connText = err instanceof Error ? err.message : t("ui.error");
		state.connKind = "off";
	}
	m.redraw();
}

const App: m.Component<{}, {}> = {
	view: () =>
		m(
			Page,
			{
				title: t("mgmt.title"),
				headerRight: m("span", { class: `badge ${state.connKind}` }, state.connText),
			},
			m(
				Card,
				{ title: t("mgmt.devices") },
				m(
							"table",
							null,
							m(
								"thead",
								null,
								m(
									"tr",
									null,
									m("th", t("mgmt.th.device")),
									m("th", t("mgmt.th.role")),
									m("th", t("mgmt.th.status")),
									m("th", t("mgmt.th.connected")),
									m("th", t("mgmt.th.stream")),
									m("th", t("mgmt.th_bitrate")),
									m("th", t("mgmt.th.links")),
									m("th", null, icon("encoder"), ` ${t("setup.step.encoder")}`),
									m("th", null, icon("relay"), ` ${t("setup.step.relay")}`),
								),
							),
							m(
								"tbody",
								state.devices?.length
									? state.devices.map(row)
									: [
											m(
												"tr",
												m("td", { colspan: COLUMNS, class: "muted" }, state.devices ? t("mgmt.none") : t("mgmt.loading")),
											),
										],
							),
				),
			),
		),
};

document.title = t("mgmt.title");
m.mount(document.getElementById("app")!, App);

void refresh();
setInterval(refresh, REFRESH_MS);
