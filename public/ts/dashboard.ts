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
	GridSize,
	Status,
	SrtlaStats,
	WidgetType,
} from "../types";
import { badge, button, widgetTable, type Child } from "./components/ui";
import { createObsPanel, type ObsEvent, type ObsPanel, type ObsRequestResult } from "../../modules/obs-controller/frontend";
import { getFrontendModule, widgetModule } from "../../modules/registry.frontend";
import { WIDGET_MODULE_IDS } from "../../modules/widgets";
import { t } from "./i18n";
import { roleTag } from "./icons";
import { RpcClient, socketUrl } from "./services/rpc";
import { formatBitrate } from "./util";

export const KICK_CHAT_CAP = 20;

/** Device-independent widget types: their data (the widget's channel, fetched
 * by the control server) is not tied to any device connection. */
const INDEPENDENT: ReadonlySet<WidgetType> = new Set<WidgetType>(WIDGET_MODULE_IDS);
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
}
interface Connection {
	rpc: RpcClient;
	live: DeviceLive;
}

// ------------------------------------------------------------------------ kick

/** Live kick data per channel, accumulated from the dashboard websocket. */
export interface KickChannelLive {
	stats?: KickStats;
	chat: KickChatMessage[];
}
export const kickLive = new Map<string, KickChannelLive>();
let kickConn: RpcClient | null = null;

/** One server websocket for the kick widgets; it feeds every channel at once. */
function ensureKickConn(): void {
	if (kickConn) return;
	const live = (channel: string): KickChannelLive => {
		let l = kickLive.get(channel);
		if (!l) {
			l = { chat: [] };
			kickLive.set(channel, l);
		}
		return l;
	};
	kickConn = new RpcClient(() => socketUrl("/dashboards/ws"));
	kickConn.on("kick.snapshot", (data) => {
		const snap = data as {
			stats?: Record<string, KickStats | null>;
			chat?: Record<string, { messages?: KickChatMessage[] }>;
		};
		for (const [channel, stats] of Object.entries(snap.stats ?? {})) if (stats) live(channel).stats = stats;
		for (const [channel, c] of Object.entries(snap.chat ?? {})) live(channel).chat = (c.messages ?? []).slice(0, KICK_CHAT_CAP);
		m.redraw();
	});
	kickConn.on("kick.stats", (data) => {
		const e = data as { channel?: string; stats?: KickStats };
		if (e.channel && e.stats) live(e.channel).stats = e.stats;
		m.redraw();
	});
	kickConn.on("kick.chat", (data) => {
		const e = data as
			| { channel?: string; message: KickChatMessage }
			| { channel?: string; reconnect: boolean; messages: KickChatMessage[] }
			| { channel?: string; disconnected: boolean };
		if (!e.channel) return;
		if ("message" in e) {
			const l = live(e.channel);
			l.chat = [e.message, ...l.chat].slice(0, KICK_CHAT_CAP);
		} else if ("messages" in e) {
			live(e.channel).chat = e.messages.slice(0, KICK_CHAT_CAP);
		}
		m.redraw();
	});
	// Cross-client sync: the control server broadcasts `dashboards.changed` here
	// whenever any client saves a dashboard; the owning page rebases against it.
	kickConn.on("dashboards.changed", (data) => onDashboardsChanged(data));
}

/** Open the dashboards websocket (shared with the kick widgets) so the page can
 * listen for `dashboards.changed` broadcasts, even when it has no kick widget. */
export function ensureDashboardsWs(): void {
	ensureKickConn();
}

/** A widget's normalized channel key ("" when not configured). */
export const widgetChannel = (w: ServerDashboardWidget): string => (w.config?.channel ?? "").trim().toLowerCase();

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

export const typeLabel = (type: WidgetType): string => t(`wtype.${type.replace("-", "_")}`);

/** Widget types a specific device offers, from its role + enabled modules. */
export function widgetTypesFor(d: DeviceSummary): WidgetType[] {
	const types: WidgetType[] = ["status"];
	if (d.role !== "encoder") types.push("stats", "relay");
	if (d.role === "encoder" || d.role === "combined") types.push("encoder");
	if (d.modules?.["obs-controller"]?.enabled) types.push("obs");
	return types;
}

/** Widget types that are not tied to a device: always offered; their data
 * (the channel name in the widget config) is fetched by the server. */
export function independentTypes(): WidgetType[] {
	return [...WIDGET_MODULE_IDS];
}

/** The device a widget's data comes from — its own for device-bound widgets;
 * kick widgets are device-independent and don't open a device connection. */
export function effectiveDeviceId(w: ServerDashboardWidget): string {
	return isIndependent(w.type) ? "" : w.deviceId;
}

// ------------------------------------------------------------------- connections

const connections = new Map<string, Connection>();

/** One viewer websocket per device referenced by the dashboard's widgets. */
export function syncConnectionsFor(dash: ServerDashboard | undefined): void {
	const wanted = new Set((dash?.widgets ?? []).map((w) => effectiveDeviceId(w)));
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
			void rpc.call("status").catch(() => undefined);
		});
	}
	if ((dash?.widgets ?? []).some((w) => isIndependent(w.type))) ensureKickConn();
}

const connectionFor = (deviceId: string): Connection | undefined => connections.get(deviceId);

// ---------------------------------------------------------------------- widgets

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

/** One panel instance per obs widget (its own timers, VU canvas, pending guards). */
const obsPanels = new Map<string, { panel: ObsPanel; conn: Connection }>();

/** The full control panel (preview, scenes, output actions, VU meter), not just the status rows. */
function obsWidget(w: ServerDashboardWidget, conn: Connection | undefined): m.Children {
	const d = deviceById(w.deviceId);

	if (!conn || !d?.online) return [badge(t("dev.badge.offline"), "off")];
	// The panel caches `conn.rpc`; if syncConnectionsFor replaced the device's
	// connection (dashboard edited, device swapped), rebind to the live one.
	const entry = obsPanels.get(w.id);
	if (entry && entry.conn !== conn) {
		entry.panel.destroy();
		obsPanels.delete(w.id);
	}
	let panel = obsPanels.get(w.id)?.panel;
	if (!panel) {
		panel = createObsPanel({
			send: <T = Record<string, unknown>>(type: string, data?: Record<string, unknown>) =>
				conn.rpc.call<ObsRequestResult<T> | undefined>("obs.request", {
					requestType: type,
					requestId: crypto.randomUUID(),
					requestData: data ?? {},
				}),
			onEvent: (h) => conn.rpc.on("obs.event", (data) => h(data as ObsEvent)),
			mirror: (s) => {
				conn.live.obsConnected = s.connected;
				conn.live.obsStreaming = s.streaming;
				conn.live.obsRecording = s.recording;
				if (s.scene) conn.live.obsScene = s.scene;
			},
			startConnected: () => conn.live.obsConnected,
			onDestroy: () => obsPanels.delete(w.id),
		});
		obsPanels.set(w.id, { panel, conn });
	}
	const p: ObsPanel = panel; // const binding — panel may be narrowed away by the closures above
	// The dashboard widget card is shared by all widget types, so scope the module CSS
	// with the same .mod-obs-controller class the device page's card root gets.
	return m("div.mod-obs-controller", [...p.head(), p.component()]);
}

/** Per-widget state of the inline config editor (pencil icon). */
interface WidgetConfigState {
	editing: boolean;
	channel: string;
	token: string;
}
const widgetConfigState = new Map<string, WidgetConfigState>();

/** Registered by the page rendering the dashboard; persists the in-place
 * widget mutation (PUT the dashboard) when the inline editor saves. */
let widgetConfigSaver: ((w: ServerDashboardWidget) => void) | null = null;
export function setWidgetConfigSaver(fn: ((w: ServerDashboardWidget) => void) | null): void {
	widgetConfigSaver = fn;
}

/** Registered by the page owning the grid; called when the server broadcasts
 * a `dashboards.changed` event (this dashboard was saved elsewhere). */
let dashboardChangedSink: ((data: { id: string; widgets: ServerDashboardWidget[]; version: number } | null) => void) | null = null;
export function setDashboardChangedSink(
	fn: ((data: { id: string; widgets: ServerDashboardWidget[]; version: number } | null) => void) | null,
): void {
	dashboardChangedSink = fn;
}
export function onDashboardsChanged(data: unknown): void {
	dashboardChangedSink?.(data as { id: string; widgets: ServerDashboardWidget[]; version: number } | null);
}

/** The inline editor that opens from the pencil icon on a configurable widget. */
function configEditorForm(w: ServerDashboardWidget): m.Vnode {
	const s =
		widgetConfigState.get(widgetKey(w)) ?? { editing: true, channel: w.config?.channel ?? "", token: w.config?.token ?? "" };
	return m("div.dash-config-form", [
		m("label", [
			m("span", t("dash.widget_channel")),
			m("input.dash-config-input", {
				value: s.channel,
				placeholder: t("dash.widget_channel"),
				oninput: (e: Event) => {
					s.channel = (e.target as HTMLInputElement).value;
				},
			}),
		]),
		(widgetModule(w.type)?.configFields.includes("token") ?? false)
			? m("label", [
					m("span", t("dash.widget_token")),
					m("input.dash-config-input", {
						value: s.token,
						placeholder: t("dash.widget_token"),
						oninput: (e: Event) => {
							s.token = (e.target as HTMLInputElement).value;
						},
					}),
				])
			: null,
		m("div.dash-config-actions", [
			button(t("ui.save"), {
				onclick: (e: Event) => {
					e.preventDefault();
					w.config = { channel: s.channel.trim(), token: widgetModule(w.type)?.configFields.includes("token") ? s.token.trim() : "" };
					widgetConfigState.delete(widgetKey(w));
					widgetConfigSaver?.(w);
					m.redraw();
				},
			}),
			button(t("ui.cancel"), {
				onclick: () => {
					widgetConfigState.delete(widgetKey(w));
					m.redraw();
				},
			}),
		]),
	]);
}

const widgetKey = (w: ServerDashboardWidget): string => w.id || `${w.type}:${w.name}`;

/** Kick widgets are device-independent: the server polls kick.com for the
 * widget's channel and pushes the data over the dashboard websocket. */
/** Card title: "device · type" for device widgets, just "type" for the channel ones. */
export function widgetTitle(w: ServerDashboardWidget): string {
	const d = deviceById(w.deviceId);
	const prefix = isIndependent(w.type) || !d ? "" : `${deviceLabel(d)} · `;
	return prefix + t(`wtype.${w.type.replace("-", "_")}`);
}

/** Live body for a widget, given its device connection. */
function bodyFor(w: ServerDashboardWidget): m.Children {
	const deviceId = effectiveDeviceId(w);
	const conn = connectionFor(deviceId);
	switch (w.type) {
		case "stats": return statsWidget(deviceId, conn);
		case "relay": return relayWidget(deviceId, conn);
		case "encoder": return encoderWidget(deviceId, conn);
		case "obs": return obsWidget(w, conn);
		case "kick-stats":
		case "kick-chat": {
			const channel = w.config?.channel?.trim().toLowerCase();
			return widgetModule(w.type)?.body(w, channel ? kickLive.get(channel) ?? { chat: [] } : {}) as m.Children;
		}
		default: return statusWidget(deviceId, conn);
	}
}

/** Default/min/max `{w, h}` for a widget type — the module contract for the
 * device/obs widgets plus sensible fallbacks for the rest, used when adding a
 * widget or constraining a resize. */
/** Device-bound widget type → the frontend module that defines its grid size. */
const WIDGET_TYPE_MODULE: Record<WidgetType, string | undefined> = {
	obs: "obs-controller",
	encoder: "encoder",
	stats: "srtla",
	relay: "srtla",
	status: undefined,
	"kick-stats": undefined,
	"kick-chat": undefined,
};

export function widgetSize(type: WidgetType): { default: GridSize; min: GridSize; max?: GridSize } {
	const mod = WIDGET_TYPE_MODULE[type] ? getFrontendModule(WIDGET_TYPE_MODULE[type]!) : undefined;
	if (mod) return { default: mod.defaultSize, min: mod.minSize, max: mod.maxSize };
	switch (type) {
		case "kick-stats": return { default: { w: 3, h: 3 }, min: { w: 3, h: 3 } };
		case "kick-chat": return { default: { w: 3, h: 8 }, min: { w: 3, h: 4 } };
		default: return { default: { w: 4, h: 4 }, min: { w: 3, h: 3 } };
	}
}

export interface WidgetActions {
	remove: (w: ServerDashboardWidget) => void;
	hide: (w: ServerDashboardWidget) => void;
}

/** The live grid content for one widget: a slim persistent header (title, and
 * in edit mode a drag grip plus remove/hide/config actions) above the live body.
 * GridStack owns the surrounding `.grid-stack-item`; this is what fills it. */
export function widgetInner(w: ServerDashboardWidget, editMode: boolean, actions: WidgetActions): m.Vnode {
	const key = widgetKey(w);
	const isKick = isIndependent(w.type);
	const editing = isKick && editMode && (widgetConfigState.get(key)?.editing ?? false);
	return m("div.dash-widget", { key, class: editing ? "is-editing" : undefined }, [
		m("div.dash-widget-head", [
			m("span.dash-grip", [
				editMode ? m("span.dash-grip-icon", "⠿") : null,
				m("span.dash-widget-title", widgetTitle(w)),
			]),
			editMode
				? m("span.dash-widget-actions", [
						isKick
							? m("button.icon-btn.dash-widget-config", {
									title: t("dash.widget_settings"),
									"aria-label": t("dash.widget_settings"),
									onclick: (e: Event) => {
										e.stopPropagation();
										const s = widgetConfigState.get(key) ?? { editing: false, channel: w.config?.channel ?? "", token: w.config?.token ?? "" };
										s.editing = !s.editing;
										widgetConfigState.set(key, s);
										m.redraw();
									},
								}, editing ? "✓" : "⚙")
							: null,
						m("button.icon-btn.dash-widget-eye", {
							title: t("dash.hide"),
							"aria-label": t("dash.hide"),
							onclick: (e: Event) => {
								e.stopPropagation();
								actions.hide(w);
							},
						}, "👁"),
						m("button.icon-btn.dash-widget-remove", {
							title: t("dash.remove"),
							"aria-label": t("dash.remove"),
							onclick: (e: Event) => {
								e.stopPropagation();
								actions.remove(w);
							},
						}, "×"),
					])
				: null,
		]),
		m("div.dash-widget-body", editing ? configEditorForm(w) : bodyFor(w)),
	]);
}
