/* Control server device list — a Mithril view of a polling fetch every few seconds. */
import m from "mithril";
import type { DeviceSummary } from "../types";
import { type BadgeKind, badge, Card, type Child, encoderIssueBadge, Page, serverNav } from "./components/ui";
import { t } from "./i18n";
import { icon, roleTag } from "./icons";
import { formatBitrate, mountPage, since } from "./util";

const REFRESH_MS = 3_000;

const state = {
	connText: t("mgmt.loading"),
	connKind: "off" as BadgeKind,
	devices: null as DeviceSummary[] | null, // null = before the first fetch landed
};

const hasEncoder = (d: DeviceSummary) => d.role === "encoder" || d.role === "combined";

/** Live stream state, mirroring the device page's encoder / srtla_send badges. */
function streamState(d: DeviceSummary): Child {
	if (!d.online) return "—";
	const { srtla: s, encoder: e } = d;
	if (hasEncoder(d)) {
		if (!e) return "—";
		const issue = encoderIssueBadge(d.role, e, s);
		if (issue) return issue;
	} else if (!s?.running) {
		return badge(t("dev.badge.stopped"), "off");
	}
	if (d.activeLinks === 0) return badge(t("dev.badge.no_links"), "warn");
	return badge(t("dev.badge.live"), "on");
}

function bitrate(d: DeviceSummary): Child {
	const live = d.online && d.bitrate !== undefined ? formatBitrate(d.bitrate) : null;
	const max = d.maxBitrate !== undefined ? t("dev.max_value", formatBitrate(d.maxBitrate * 125)) : null;
	if (live && max) return m("span", live, " / ", m("span.muted", max));
	return live ?? max ?? "—";
}

function row(d: DeviceSummary): m.Vnode {
	const { srtla: s, encoder: e } = d;
	const stopped = badge(t("dev.badge.stopped"), "warn");
	return m(
		"tr",
		{ key: d.id },
		// The dot wears the device's header color and beats while the link is up;
		// the uuid is stable, the hostname is the display name (shown when present)
		m(
			"td",
			m(
				"a.device",
				{ href: `d/${encodeURIComponent(d.id)}/`, title: d.id },
				m("span.device-dot", {
					class: d.online ? "online" : "",
					style: d.color ? `background:${d.color};color:${d.color}` : "",
				}),
				d.hostname || d.id,
			),
		),
		m("td.muted", d.role ? roleTag(d.role) : "—"),
		m("td", d.online ? badge(t("dev.badge.online"), "on") : badge(t("dev.badge.offline"), "off")),
		m("td", d.online ? since(d.connectedAt) : t("mgmt.last_seen", since(d.lastSeen))),
		m("td", streamState(d)),
		m("td", bitrate(d)),
		m("td", d.online && d.totalLinks !== undefined ? `${d.activeLinks ?? 0}/${d.totalLinks}` : "—"),
		m(
			"td",
			hasEncoder(d) && e ? (e.running ? badge(e.config?.pipeline ?? t("dev.badge.streaming"), "on") : stopped) : "—",
		),
		m(
			"td",
			d.role !== "encoder" && s ? (s.running ? badge(`→ ${s.remoteHost}:${s.remotePort}`, "on") : stopped) : "—",
		),
	);
}

const columnHeaders = (): m.Children[] => [
	t("mgmt.th.device"),
	t("mgmt.th.role"),
	t("mgmt.th.status"),
	t("mgmt.th.connected"),
	t("mgmt.th.stream"),
	t("mgmt.th_bitrate"),
	t("mgmt.th.links"),
	[icon("encoder"), ` ${t("setup.step.encoder")}`],
	[icon("relay"), ` ${t("setup.step.relay")}`],
];

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

const App: m.Component = {
	view: () => {
		const headers = columnHeaders();
		return m(
			Page,
			{ title: t("mgmt.title"), nav: serverNav("devices"), headerRight: badge(state.connText, state.connKind) },
			m(
				Card,
				{  },
				m(
					"table",
					m("thead", m("tr", headers.map((h) => m("th", h)))),
					m(
						"tbody",
						state.devices?.length
							? state.devices.map(row)
							: m(
									"tr",
									m(
										"td",
										{ colspan: headers.length, class: "muted" },
										state.devices ? t("mgmt.none") : t("mgmt.loading"),
									),
								),
					),
				),
			),
		);
	},
};

void mountPage(() => t("mgmt.title"), App);
void refresh();
setInterval(refresh, REFRESH_MS);
