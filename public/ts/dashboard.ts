/* Shared dashboard parts: the live widget preview is used both by the dashboards
 * management page and by the read-only dashboard view page. Devices are polled for
 * config; live widget data flows over the control server's per-device viewer
 * websocket (d/<id>/ws). */
import m from "mithril";
import type {
	DeviceInfo,
	DeviceSummary,
	KickChatMessage,
	KickStats,
	ServerDashboard,
	ServerDashboardWidget,
	Status,
	SrtlaStats,
	WidgetType,
} from "../types";
import { badge, type Child } from "./components/ui";
import { t } from "./i18n";
import { roleTag } from "./icons";
import { RpcClient, socketUrl } from "./services/rpc";
import { formatBitrate } from "./util";

export const KICK_CHAT_CAP = 20;

/** Widget types shown without a device label; their data comes from the first
 * device that has the module enabled (the widget's stored device id). */
const INDEPENDENT: ReadonlySet<WidgetType> = new Set<WidgetType>(["kick-stats", "kick-chat"]);
export const isIndependent = (type: WidgetType): boolean => INDEPENDENT.has(type);

/** Live data for one device, accumulated from its viewer websocket (or a 409). */
interface DeviceLive {
	device?: DeviceInfo;
	status?: Status;
	srtla?: SrtlaStats;
	obsConnected: boolean;
	obsScene?: string;
	obsStreaming: boolean;
	obsRecording: boolean;
	kickStats?: KickStats;
	kickChat: KickChatMessage[];
}
interface Connection {
	rpc: RpcClient;
	live: DeviceLive;
}

// ---------------------------------------------------------------------- devices

export const devices: { list: DeviceSummary[] | null } = { list: null };

export async function refreshDevices(): Promise<void> {
	try {
		const res = await fetch("/api/devices", { cache: "no-store" });
		if (!res.ok) throw new Error(`HTTP ${res.status}`);
		devices.list = (await res.json()) as DeviceSummary[];
	} catch {
		// keep the last known list; connectivity is also visible in the live widgets
	}
	m.redraw();
}

export const deviceById = (deviceId: string): DeviceSummary | undefined =>
	devices.list?.find((d) => d.id === deviceId);

export const deviceLabel = (d: DeviceSummary): string => d.hostname || d.id;

/** The module key a widget type reads from. */
export const moduleKeyFor = (type: WidgetType): "kick-stats" | "kick-chat" => (type === "kick-chat" ? "kick-chat" : "kick-stats");

/** First online device with the module a widget type needs (data source for
 * the channel widgets). */
export function sourceDeviceFor(type: WidgetType): DeviceSummary | undefined {
	return devices.list?.find((d) => d.online && d.modules?.[moduleKeyFor(type)]?.enabled);
}

export const typeLabel = (type: WidgetType): string => t(`wtype.${type.replace("-", "_")}`);

/** Widget types a specific device offers, from its role + enabled modules. */
export function widgetTypesFor(d: DeviceSummary): WidgetType[] {
	const types: WidgetType[] = ["status"];
	if (d.role !== "encoder") types.push("stats", "relay");
	if (d.role === "encoder" || d.role === "combined") types.push("encoder");
	if (d.modules?.["obs-controller"]?.enabled) types.push("obs");
	return types;
}

/** Widget types that are not tied to one specific device: addable without a
 * device selection, fed by the first device that has the module enabled. */
export function independentTypes(): WidgetType[] {
	const all: WidgetType[] = ["kick-stats", "kick-chat"];
	return all.filter((tp) => sourceDeviceFor(tp) !== undefined);
}

// ------------------------------------------------------------------- connections

const connections = new Map<string, Connection>();

/** One viewer websocket per device referenced by the dashboard's widgets. */
export function syncConnectionsFor(dash: ServerDashboard | undefined): void {
	const wanted = new Set((dash?.widgets ?? []).map((w) => w.deviceId));
	for (const [id, conn] of connections) {
		if (!wanted.has(id) || !id) {
			conn.rpc.destroy();
			connections.delete(id);
		}
	}
	for (const id of wanted) {
		if (!id || connections.has(id)) continue;
		const live: DeviceLive = {
			obsConnected: false,
			obsStreaming: false,
			obsRecording: false,
			kickChat: [],
		};
		const rpc = new RpcClient(() => socketUrl(`/d/${encodeURIComponent(id)}/ws`));
		const conn: Connection = { rpc, live };
		connections.set(id, conn);
		rpc.on("device", (data) => (live.device = data as DeviceInfo));
		rpc.on("status", (data) => (live.status = data as Status));
		rpc.on("srtla.stats", (data) => (live.srtla = (data as { stats?: SrtlaStats })?.stats ?? undefined));
		rpc.on("obs.event", (data) => {
			const e = data as { eventType: string; eventData?: Record<string, unknown> };
			if (e.eventType === "CurrentProgramSceneChanged") {
				live.obsConnected = true;
				live.obsScene = String(e.eventData?.outputName ?? e.eventData?.sceneName ?? "");
			} else if (e.eventType === "StreamStateChanged") {
				live.obsConnected = true;
				live.obsStreaming = Boolean(e.eventData?.outputActive);
			} else if (e.eventType === "RecordStateChanged") {
				live.obsConnected = true;
				live.obsRecording = Boolean(e.eventData?.outputActive);
			} else if (e.eventType === "ObsDisconnected") {
				live.obsConnected = false;
				live.obsStreaming = false;
				live.obsRecording = false;
			}
			m.redraw();
		});
		rpc.on("kick.stats", (data) => {
			live.kickStats = data as KickStats;
			m.redraw();
		});
		rpc.on("kick.chat", (data) => {
			const e = data as
				| { message: KickChatMessage }
				| { reconnect: boolean; messages: KickChatMessage[] }
				| { disconnected: boolean };
			if ("message" in e) {
				live.kickChat = [e.message, ...live.kickChat].slice(0, KICK_CHAT_CAP);
			} else if ("messages" in e) {
				live.kickChat = e.messages.slice(0, KICK_CHAT_CAP);
			}
			m.redraw();
		});
		// Warm start: pull last snapshots once the socket is open (a 409 means the
		// module is not enabled there). `call` rejects before the socket is OPEN, so
		// this must run from the "open" event — initial connect and every reconnect.
		rpc.on("open", () => {
			const kinds = (dash?.widgets ?? []).map((w) => w.type);
			if (kinds.includes("obs")) {
				rpc
					.call("obs.request", { requestType: "GetVersion" })
					.then(() => {
						live.obsConnected = true;
						m.redraw();
					})
					.catch(() => undefined);
			}
			if (kinds.includes("kick-stats")) {
				rpc
					.call<{ stats?: KickStats }>("kick.stats.get")
					.then((r) => (live.kickStats = r.stats))
					.catch(() => undefined);
			}
			if (kinds.includes("kick-chat")) {
				rpc
					.call<{ messages?: KickChatMessage[]; stats?: KickStats }>("kick.chat.get", { limit: KICK_CHAT_CAP })
					.then((r) => (live.kickChat = (r.messages ?? []).slice(0, KICK_CHAT_CAP)))
					.catch(() => undefined);
			}
			void rpc.call("status").catch(() => undefined);
		});
	}
}

const connectionFor = (deviceId: string): Connection | undefined => connections.get(deviceId);

// ---------------------------------------------------------------------- widgets

function widgetTable(rows: [string, Child][]): m.Vnode {
	return m(
		"table.dash-table",
		m("tbody", rows.map(([label, value], i) => m("tr", { key: i }, m("th", label), m("td", value)))),
	);
}

function srtlaTable(s: SrtlaStats): m.Vnode {
	return srtlaLinksRows(s).length
		? m(
				"table.dash-table",
				m("tbody", srtlaLinksRows(s).map(([label, value], i) => m("tr", { key: i }, m("th", label), m("td", value)))),
			)
		: m("p.muted", t("dev.badge.no_links"));
}

function srtlaLinksRows(s: SrtlaStats): [string, Child][] {
	return (s.links ?? []).map((l) => [
		l.label ?? l.ip,
		m(
			"span",
			l.connected ? badge(t("dev.badge.online"), "on") : badge(t("dev.badge.offline"), "off"),
			" ",
			m("span.muted", `${formatBitrate(l.bitrate_bytes_per_sec)} · ${l.rtt_ms} ms`),
		),
	]);
}

function statusWidget(deviceId: string, conn: Connection | undefined): m.Children {
	const d = deviceById(deviceId);
	if (!d) return [badge(t("dash.widget_missing"), "warn")];
	const offline = !conn || !d.online;
	const rows: [string, Child][] = [
		[t("mgmt.th.role"), d.role ? roleTag(d.role) : "—"],
		[t("mgmt.th.status"), d.online ? badge(t("dev.badge.online"), "on") : badge(t("dev.badge.offline"), "off")],
	];
	if (d.role !== "encoder" && conn?.live.srtla) {
		const s = conn.live.srtla;
		rows.push([t("mgmt.th.links"), `${s.active_links ?? 0}/${s.total_links ?? 0}`]);
		const total = (s.links ?? []).reduce((sum, l) => sum + (l.bitrate_bytes_per_sec ?? 0), 0);
		if (total) rows.push([t("mgmt.th_bitrate"), formatBitrate(total)]);
	}
	if (d.role !== "relay" && d.encoder) {
		rows.push([
			t("dev.card.encoder"),
			d.encoder.running
				? badge(d.encoder.config?.pipeline ?? t("dev.badge.streaming"), "on")
				: badge(t("dev.badge.stopped"), "warn"),
		]);
	}
	return [badge(offline ? t("dev.badge.offline") : t("dev.badge.online"), offline ? "off" : "on"), widgetTable(rows)];
}

function statsWidget(_deviceId: string, conn: Connection | undefined): m.Children {
	const s = conn?.live.srtla;
	if (!s) return [badge(conn ? t("dash.widget_waiting") : t("dev.badge.offline"), conn ? "" : "off")];
	return [badge(`${s.active_links ?? 0}/${s.total_links ?? 0}`, "on"), srtlaTable(s)];
}

function relayWidget(deviceId: string, conn: Connection | undefined): m.Children {
	const st = conn?.live.status?.state;
	const offline = !conn || !st;
	const rows: [string, Child][] = [
		[t("dev.card.srtla"), st?.srtla?.running ? badge(t("dev.badge.online"), "on") : badge(t("dev.badge.stopped"), "warn")],
	];
	if (st?.srtla) rows.push([t("dev.field.remote_host"), `${st.srtla.remoteHost}:${st.srtla.remotePort}`]);
	return [
		badge(offline ? t("dev.badge.offline") : t("dev.badge.online"), offline ? "off" : "on"),
		widgetTable(rows),
	];
}

function encoderWidget(deviceId: string, conn: Connection | undefined): m.Children {
	const d = deviceById(deviceId);
	const e = d?.encoder ?? conn?.live.status?.state?.encoder;
	if (!d || !e) return [badge(!conn ? t("dev.badge.offline") : t("dash.widget_waiting"), conn ? "" : "off")];
	const rows: [string, Child][] = [
		[t("dev.card.encoder"), e.running ? badge(t("dev.badge.online"), "on") : badge(t("dev.badge.stopped"), "warn")],
	];
	if (e.config?.pipeline) rows.push([t("dash.widget.pipeline"), e.config.pipeline]);
	if (e.config?.maxBitrate) rows.push([t("dash.widget.max"), formatBitrate(e.config.maxBitrate * 125)]);
	return [
		badge(!conn ? t("dev.badge.offline") : e.running ? t("dev.badge.online") : t("dev.badge.stopped"), !conn ? "off" : e.running ? "on" : "warn"),
		widgetTable(rows),
	];
}

/** Whether the device (if known) does not have the module a widget's type needs. */
const moduleEnabledOn = (d: DeviceSummary | undefined, key: string): boolean =>
	!(d?.modules && (d.modules as unknown as Record<string, { enabled?: boolean } | undefined>)[key]?.enabled);

function obsWidget(deviceId: string, conn: Connection | undefined): m.Children {
	const d = deviceById(deviceId);
	if (moduleEnabledOn(d, "obs-controller")) return [badge(t("dash.widget_module_off"), "warn")];
	if (!conn || !d?.online) return [badge(t("dev.badge.offline"), "off")];
	const live = conn.live;
	const rows: [string, Child][] = [];
	if (live.obsScene) rows.push([t("dash.widget.scene"), live.obsScene]);
	rows.push([
		t("dash.widget.streaming"),
		live.obsStreaming ? badge(t("dev.badge.streaming"), "on") : badge(t("dev.badge.stopped"), "off"),
	]);
	rows.push([
		t("dash.widget.recording"),
		live.obsRecording ? badge(t("dev.badge.streaming"), "on") : badge(t("dev.badge.stopped"), "off"),
	]);
	return [
		badge(live.obsConnected ? t("dev.badge.online") : t("dev.badge.offline"), live.obsConnected ? "on" : "off"),
		widgetTable(rows),
	];
}

function kickStatsWidget(deviceId: string, conn: Connection | undefined): m.Children {
	const d = deviceById(deviceId);
	if (moduleEnabledOn(d, "kick-stats")) return [badge(t("dash.widget_module_off"), "warn")];
	const s = conn?.live.kickStats;
	if (!conn || !d?.online || !s)
		return [badge(!conn ? t("dev.badge.offline") : t("dash.widget_waiting"), conn && d?.online ? "" : "off")];
	const rows: [string, Child][] = [
		[t("kickstats.viewers"), String(s.viewers ?? "—")],
		[t("kickstats.followers"), String(s.followers ?? "—")],
		[t("kickstats.live"), s.isLive ? badge(t("dev.badge.streaming"), "on") : badge(t("dev.badge.stopped"), "off")],
	];
	if (s.title) rows.push([t("kickstats.title"), s.title]);
	return [badge(s.isLive ? t("dev.badge.streaming") : t("dev.badge.offline"), s.isLive ? "on" : "off"), widgetTable(rows)];
}

function kickChatWidget(deviceId: string, conn: Connection | undefined): m.Children {
	const d = deviceById(deviceId);
	if (moduleEnabledOn(d, "kick-chat")) return [badge(t("dash.widget_module_off"), "warn")];
	if (!conn || !d?.online) return [badge(t("dev.badge.offline"), "off")];
	const msgs = (conn.live.kickChat ?? []).map((c) =>
		m(
			"div.kick-chat-line",
			{ key: String(c.id) },
			c.username ? m("span.chat-user", c.username) : null,
			m("span.chat-text", c.text ?? ""),
		),
	);
	return [
		badge(t("dev.badge.online"), "on"),
		msgs.length ? m("div.kick-chat-feed", msgs) : m("p.muted", t("kickchat.empty")),
	];
}

/** Card title: "device · type" for device widgets, just "type" for the channel ones. */
export function widgetTitle(w: ServerDashboardWidget): string {
	const d = deviceById(w.deviceId);
	const prefix = isIndependent(w.type) || !d ? "" : `${deviceLabel(d)} · `;
	return prefix + t(`wtype.${w.type.replace("-", "_")}`);
}

export function widgetView(w: ServerDashboardWidget): m.Vnode {
	const conn = connectionFor(w.deviceId);
	let body: m.Children;
	switch (w.type) {
		case "stats": body = statsWidget(w.deviceId, conn); break;
		case "relay": body = relayWidget(w.deviceId, conn); break;
		case "encoder": body = encoderWidget(w.deviceId, conn); break;
		case "obs": body = obsWidget(w.deviceId, conn); break;
		case "kick-stats": body = kickStatsWidget(w.deviceId, conn); break;
		case "kick-chat": body = kickChatWidget(w.deviceId, conn); break;
		default: body = statusWidget(w.deviceId, conn);
	}
	return m("div.dashboard-item", { key: w.id || `${w.deviceId}:${w.type}:${w.name}`, class: `dash-w-${w.width}` }, m("article.card.dashboard-card", m("h2", widgetTitle(w)), body));
}
