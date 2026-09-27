import { badge, byId, h, since } from "../../public/dom";
import type { DeviceSummary } from "../../public/types";

const REFRESH_MS = 3_000;

const ROLE_LABEL = { relay: "relay", encoder: "encoder", combined: "encoder + relay" } as const;

function row(d: DeviceSummary): HTMLTableRowElement {
	const s = d.srtla;
	const e = d.encoder;
	const hasEncoder = d.role === "encoder" || d.role === "combined";
	const hasRelay = d.role !== "encoder";
	return h(
		"tr",
		{},
		h("td", {}, h("a", { className: "device", href: `d/${encodeURIComponent(d.id)}/` }, d.id)),
		h("td", {}, d.role ? ROLE_LABEL[d.role] : "—"),
		h("td", {}, d.online ? badge("online", "on") : badge("offline", "off")),
		h("td", {}, d.address || "—"),
		h("td", {}, d.online ? since(d.connectedAt) : `last seen ${since(d.lastSeen)}`),
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
		h("td", {}, hasRelay && d.uplinks?.length ? d.uplinks.join(", ") : "—"),
		h("td", {}, hasRelay ? (d.modems ?? "—") : "—"),
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
				: [h("tr", {}, h("td", { colSpan: 9, className: "muted" }, "No devices have connected yet."))]),
		);
	} catch (err) {
		conn.textContent = err instanceof Error ? err.message : "error";
		conn.className = "badge off";
	}
}

void refresh();
setInterval(refresh, REFRESH_MS);
