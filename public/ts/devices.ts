import { badge, byId, type Child, formatBitrate, h, since } from "./dom";
import { icon, roleTag, type Shape } from "./icons";
import type { DeviceSummary } from "../types";

const REFRESH_MS = 3_000;
const COLUMNS = 9;

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
	return d.online && d.bitrate !== undefined ? formatBitrate(d.bitrate) : "—";
}

function links(d: DeviceSummary): Child {
	return d.online && d.totalLinks !== undefined ? `${d.activeLinks ?? 0}/${d.totalLinks}` : "—";
}

function row(d: DeviceSummary): HTMLTableRowElement {
	const s = d.srtla;
	const e = d.encoder;
	const hasEncoder = d.role === "encoder" || d.role === "combined";
	const hasRelay = d.role !== "encoder";
	return h(
		"tr",
		{},
		h(
			"td",
			{},
			h("a", { className: "device", href: `d/${encodeURIComponent(d.id)}/` }, d.id),
		),
		h("td", { className: "muted" }, d.role ? roleTag(d.role) : "—"),
		h("td", {}, d.online ? badge("online", "on") : badge("offline", "off")),
		h("td", {}, d.online ? since(d.connectedAt) : `last seen ${since(d.lastSeen)}`),
		h("td", {}, streamState(d)),
		h("td", {}, bitrate(d)),
		h("td", {}, links(d)),
		h(
			"td",
			{},
			hasEncoder && e
				? e.running
					? badge(e.config?.pipeline ?? "streaming", "on")
					: badge("stopped", "warn")
				: "—",
		),
		h(
			"td",
			{},
			hasRelay && s ? (s.running ? badge(`→ ${s.remoteHost}:${s.remotePort}`, "on") : badge("stopped", "warn")) : "—",
		),
	);
}

async function refresh(): Promise<void> {
	const conn = byId("conn");
	try {
		const res = await fetch("api/devices", { cache: "no-store" });
		if (!res.ok) throw new Error(`HTTP ${res.status}`);
		const list = (await res.json()) as DeviceSummary[];
		const online = list.filter((d) => d.online).length;
		conn.textContent = `${online}/${list.length} online`;
		conn.className = `badge ${online ? "on" : "warn"}`;
		byId("device-rows").replaceChildren(
			...(list.length
				? list.map(row)
				: [h("tr", {}, h("td", { colSpan: COLUMNS, className: "muted" }, "No devices have connected yet."))]),
		);
	} catch (err) {
		conn.textContent = err instanceof Error ? err.message : "error";
		conn.className = "badge off";
	}
}

// Column headers for the encoder / relay parts get the matching device icon
for (const th of document.querySelectorAll<HTMLElement>("th[data-icon]")) {
	th.prepend(icon(th.dataset.icon as Shape), " ");
}

void refresh();
setInterval(refresh, REFRESH_MS);
