/* Control server device list — a Mithril view of a polling fetch every few seconds. */
import m from "mithril";
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

const state: UiState = { connText: "loading", connKind: "off", devices: null };

/** Live stream state, mirroring the device page's encoder / srtla_send badges. */
function streamState(d: DeviceSummary): Child {
	if (!d.online) return "—";
	const s = d.srtla;
	const e = d.encoder;
	if (d.role === "encoder" || d.role === "combined") {
		if (!e) return "—";
		if (!e.running) return badge("stopped", "off");
		if (d.role === "combined" && !s?.running) return badge("srtla_send down", "warn");
		if (!e.pid && e.restarts) return badge("restarting", "warn");
	} else if (!s?.running) {
		return badge("stopped", "off");
	}
	if (d.activeLinks === 0) return badge("no links", "warn");
	return badge("live", "on");
}

function bitrate(d: DeviceSummary): Child {
	const live = d.online && d.bitrate !== undefined ? formatBitrate(d.bitrate) : null;
	const max = d.maxBitrate !== undefined ? `max ${formatBitrate(d.maxBitrate * 125)}` : null;
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
		m("td", m("a.device", { href: `d/${encodeURIComponent(d.id)}/` }, d.id)),
		m("td.muted", d.role ? roleTag(d.role) : "—"),
		m("td", d.online ? badge("online", "on") : badge("offline", "off")),
		m("td", d.online ? since(d.connectedAt) : `last seen ${since(d.lastSeen)}`),
		m("td", streamState(d)),
		m("td", bitrate(d)),
		m("td", links(d)),
		m(
			"td",
			hasEncoder && e
				? e.running
					? badge(e.config?.pipeline ?? "streaming", "on")
					: badge("stopped", "warn")
				: "—",
		),
		m(
			"td",
			hasRelay && s ? (s.running ? badge(`→ ${s.remoteHost}:${s.remotePort}`, "on") : badge("stopped", "warn")) : "—",
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
		state.connText = `${online}/${list.length} online`;
		state.connKind = online ? "on" : "warn";
	} catch (err) {
		state.connText = err instanceof Error ? err.message : "error";
		state.connKind = "off";
	}
	m.redraw();
}

const App: m.Component<{}, {}> = {
	view: () =>
		m(
			Page,
			{
				title: "Belabox Duo control",
				headerRight: m("span", { class: `badge ${state.connKind}` }, state.connText),
			},
			m(
				Card,
				{ title: "Devices" },
				m(
							"table",
							null,
							m(
								"thead",
								null,
								m(
									"tr",
									null,
									m("th", "Device"),
									m("th", "Type"),
									m("th", "State"),
									m("th", "Connected"),
									m("th", "Stream"),
									m("th", "Bitrate / max"),
									m("th", "Links"),
									m("th", null, icon("encoder"), " Encoder"),
									m("th", null, icon("relay"), " Relay"),
								),
							),
							m(
								"tbody",
								state.devices?.length
									? state.devices.map(row)
									: [
											m(
												"tr",
												m("td", { colspan: COLUMNS, class: "muted" }, state.devices ? "No devices have connected yet." : "Loading…"),
											),
										],
							),
				),
			),
		),
};

m.mount(document.getElementById("app")!, App);

void refresh();
setInterval(refresh, REFRESH_MS);
