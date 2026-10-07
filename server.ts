#!/usr/bin/env bun
/*
 * SRTLA control server.
 *
 * Devices (relay, encoder, or combined encoder+relay) connect out to this server (`client.ts --remote ws(s)://host:port/device`)
 * and operators control them from a browser, using the relay's own web UI
 * (../public) served per device.
 *
 * Endpoints:
 *   GET  /                 device list (public/devices.html)
 *   GET  /d/<id>/          device UI (public/index.html); the setup wizard
 *                          (public/setup.html) while the device has no config
 *                          file (status.setupRequired; ?ui=1 forces the UI)
 *   GET  /d/<id>/settings/ device settings (public/settings.html)
 *   GET  /d/<id>/setup/    setup wizard for one device
 *   WS   /d/<id>/ws        browser ⇄ device; same protocol as the relay's local /ws
 *   GET  /api/devices      JSON list of known devices
 *   GET  /dashboards/      server dashboards: compose dashboards from the modules
 *                          of connected devices (public/dashboards.html)
 *   GET  /dashboards/view/<id>/  /edit/<id>/  dashboard grid; edit starts in
 *                          edit mode (public/dashboardview.html)
 *   GET  /dashboards/add/<id>/   dedicated "add widget" page (public/dashboardadd.html)
 *   GET  /api/dashboards   JSON list of dashboards
 *   POST /api/dashboards   create a dashboard {name, widgets}
 *   PUT  /api/dashboards/<id>   replace a dashboard {name, widgets}
 *   DEL  /api/dashboards/<id>   remove a dashboard
 *   WS   /device           device connections (Authorization: Bearer <token>, x-device-id: <id>,
 *                          x-device-role: relay|encoder|combined)
 *   WS   /dashboards/ws    live kick data (kick.stats / kick.chat events,
 *                          kick.snapshot on connect) for the kick widgets; the
 *                          server polls kick.com per widget channel
 *   GET  /healthz          liveness (no auth)
 *
 * Devices are keyed by a stable UUID (hostnames change); the per-device
 * parameters (hostname, color, role) the server keeps for each uuid arrive in
 * the device's hello frame:
 *   { "type": "hello", "id": "<uuid>", "role": …, "hostname": …, "color": … }
 *
 * Browser requests `{id, method, params}` are forwarded to the device with a
 * server-unique id; responses are routed back with the browser's id restored.
 * Device `event` frames (status, srtla.stats, …) fan out to all viewers of that
 * device; the last status and link stats are cached and replayed to new viewers. Viewers also receive
 * `{type:"event", event:"device", data:{id, online, hostname, color, …}}` on
 * connect and whenever the device connects or disconnects.
 * The device's event log (`log` events) is cached too, merged with this server's own
 * "Device online / offline" entries (in memory only), and replayed to new viewers as a reset.
 * Entries are memory-only: a device with no heartbeat for 5 minutes is removed from the
 * list and reappears from scratch the next time it connects.
 *
 * Auth:
 *   devices  shared token (--device-token / SRTLA_DEVICE_TOKEN) and/or a JSON
 *            file of per-device tokens (--devices devices.json: {"<device uuid>": "token"})
 *   browser  HTTP Basic (--ui-user / SRTLA_UI_USER, default "admin";
 *            --ui-password / SRTLA_UI_PASSWORD)
 *   --no-auth disables both (local testing only).
 *
 * Dashboards are a server-level feature: the dashboards page composes them from the
 * modules of connected devices and persists them to --dashboards (default
 * dashboards.json, created on the first change).
 *
 * Usage:
 *   SRTLA_DEVICE_TOKEN=devsecret SRTLA_UI_PASSWORD=uipass bun server.ts --port 8090
 */
import type { ServerWebSocket } from "bun";
import { createHash, randomUUID, timingSafeEqual } from "node:crypto";
import type { DeviceInfo, DeviceSummary, ServerDashboard, ServerDashboardWidget, SrtlaStats, SrtlaStatsEvent, Status, WidgetType } from "./public/types";
import { arg, argFail, flag, intArg } from "./src/args";
import { imageResponse, notFound, originAllowed, text, upgradeRequired } from "./src/http";
import { isLanguage, type Language, translate } from "./src/i18n";
import { initWidgetHub, syncWidgetHub, widgetHubSnapshot } from "./modules/registry.backend";
import { LOG_MAX, type LogEntry, type LogEvent, type LogLevel } from "./src/logMessages";
import { parseJsonObject, textOf } from "./src/util";
import { COLOR_RE, isRole, type Role } from "./src/validate";

const PORT         = intArg("--port", 8090, 1, 65535);
const HOST         = arg("--host", "0.0.0.0");

const DEVICE_TOKEN = arg("--device-token", process.env.SRTLA_DEVICE_TOKEN ?? "");
const DEVICES_FILE = arg("--devices");

const UI_USER      = arg("--ui-user", process.env.SRTLA_UI_USER ?? "admin");
const UI_PASSWORD  = arg("--ui-password", process.env.SRTLA_UI_PASSWORD ?? "");
const NO_AUTH      = flag("--no-auth");
const DASHBOARDS_FILE = arg("--dashboards", "dashboards.json");

const STALE_DEVICE_MS   = 5 * 60 * 1000;
const PRUNE_INTERVAL_MS = 30 * 1000;
const REQUEST_TIMEOUT_MS = 60_000;

const ID_RE = /^[\w.-]{1,64}$/;
// /d/<id>, /d/<id>/, /d/<id>/ws, /d/<id>/settings[/], /d/<id>/setup[/]
const DEVICE_PATH_RE = /^\/d\/([^/]+)(?:(\/)(?:(ws)|(settings|setup)(\/)?)?)?$/;
const WIDGET_TYPES: WidgetType[] = ["obs", "stats", "status", "relay", "encoder", "combined", "kick-stats", "kick-chat"];
const DASH_PATH_RE = /^\/api\/dashboards(?:\/([\w.-]{1,64}))?$/;
const viewersTopic = (id: string) => `viewers:${id}`;
const dashboardsTopic = "dashboards:kick";
const INDEPENDENT_WIDGETS: ReadonlySet<WidgetType> = new Set(["kick-stats", "kick-chat"]);
const DASH_COLUMNS = 12;
/** Default `{w, h}` per widget type — seeds new widgets and migrates v1 rows. */
const WIDGET_SIZE: Record<WidgetType, { w: number; h: number }> = {
	obs: { w: 6, h: 6 },
	status: { w: 4, h: 4 },
	stats: { w: 4, h: 4 },
	relay: { w: 4, h: 4 },
	encoder: { w: 6, h: 5 },
	combined: { w: 6, h: 10 },
	"kick-stats": { w: 3, h: 3 },
	"kick-chat": { w: 3, h: 8 },
};

// ----------------------------------------------------------------------
// Auth
// ----------------------------------------------------------------------
const deviceTokens: Record<string, string> = DEVICES_FILE
    ? await Bun.file(DEVICES_FILE).json().catch((err: unknown) =>
          argFail("--devices", DEVICES_FILE, `readable JSON {"id":"token"} (${String(err)})`))
    : {};

if (!NO_AUTH) {
    if (!UI_PASSWORD) {
        console.error("Set --ui-password (or SRTLA_UI_PASSWORD), or pass --no-auth for local testing.");
        process.exit(2);
    }
    if (!DEVICE_TOKEN && Object.keys(deviceTokens).length === 0) {
        console.error("Set --device-token (or SRTLA_DEVICE_TOKEN) and/or --devices, or pass --no-auth.");
        process.exit(2);
    }
}

const digest = (s: string) => createHash("sha256").update(s).digest();
const safeEqual = (a: string, b: string): boolean => timingSafeEqual(digest(a), digest(b));

function deviceAuthorized(id: string, token: string): boolean {
    if (NO_AUTH) return true;
    const own = deviceTokens[id];
    if (own !== undefined) return safeEqual(token, own);
    return !!DEVICE_TOKEN && safeEqual(token, DEVICE_TOKEN);
}

function uiAuthorized(req: Request): boolean {
    if (NO_AUTH) return true;
    const m = req.headers.get("authorization")?.match(/^Basic\s+(\S+)$/i);
    if (!m) return false;
    const decoded = Buffer.from(m[1], "base64").toString();
    const sep = decoded.indexOf(":");
    if (sep < 0) return false;
    // Evaluate both so timing does not reveal which part was wrong
    const userOk = safeEqual(decoded.slice(0, sep), UI_USER);
    const passOk = safeEqual(decoded.slice(sep + 1), UI_PASSWORD);
    return userOk && passOk;
}

const unauthorized = () =>
    text("Authentication required", 401, { "www-authenticate": 'Basic realm="SRTLA control", charset="UTF-8"' });

// ----------------------------------------------------------------------
// Frontend (bundled once at startup so it can sit behind auth)
// ----------------------------------------------------------------------
const PAGES = ["devices", "index", "settings", "setup", "dashboards", "dashboardview", "dashboardadd"] as const;
type PageName = (typeof PAGES)[number];
const pages = {} as Record<PageName, string>;
const assets = new Map<string, Blob>();
{
    // One build for all pages: shared code (mithril, UI components) lands in common chunks
    const result = await Bun.build({
        entrypoints: PAGES.map((name) => new URL(`./public/${name}.html`, import.meta.url).pathname),
        target: "browser",
        minify: true,
        splitting: true,
        publicPath: "/assets/",
        naming: { asset: "[name]-[hash].[ext]", chunk: "[name]-[hash].[ext]", entry: "[name]-[hash].[ext]" },
    });
    if (!result.success) {
        for (const l of result.logs) console.error(l);
        throw new Error("Failed to bundle the web UI");
    }
    for (const out of result.outputs) {
        const file = out.path.replace(/^\.\//, "");
        const page = PAGES.find((name) => file.startsWith(`${name}-`) && file.endsWith(".html"));
        if (page) pages[page] = await out.text();
        else assets.set(file, out);
    }
}

const htmlResponse = (page: PageName) =>
    new Response(pages[page], { headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-cache" } });

// ----------------------------------------------------------------------
// Device registry and request routing
// ----------------------------------------------------------------------
type WsData =
    | { kind: "device"; id: string; address: string; role?: Role }
    | { kind: "viewer"; id: string }
    | { kind: "dashboards" };
type Socket = ServerWebSocket<WsData>;

interface Device {
    /** Stable uuid; the key of this entry. Hostnames change, so the id does not */
    id: string;
    hostname?: string;        // display name, from the device's hello
    color?: string;           // the device's header color, from the device's hello
    language?: Language;      // UI language, from the device's hello
    role?: Role;              // device type, from the upgrade header / hello / status
    ws: Socket | null;
    address?: string;
    connectedAt?: number;
    lastSeen?: number;
    statusMsg?: string;       // last serialized status event, replayed to new viewers
    statsMsg?: string;        // last srtla.stats event, likewise
    stats?: SrtlaStats | null;
    status?: Status;
    statusAt?: number;
    log: LogEntry[];          // the device's own event log, as last pushed
    serverLog: LogEntry[];    // online / offline entries added here
}

interface Pending {
    deviceId: string;
    viewer: Socket;
    clientId: unknown;
    method: string;
    timer: ReturnType<typeof setTimeout>;
}

const devices = new Map<string, Device>();
const newDevice = (id: string): Device => ({ id, ws: null, log: [], serverLog: [] });
const pending = new Map<number, Pending>();
let nextRequestId = 1;
let nextServerLogId = 1;

const deviceFor = (id: string): Device => {
    let d = devices.get(id);
    if (!d) devices.set(id, (d = newDevice(id)));
    return d;
};

const deviceInfo = (d: Device): DeviceInfo => ({
    id: d.id,
    hostname: d.hostname,
    color: d.color,
    language: d.language,
    role: d.role,
    online: d.ws !== null,
    connectedAt: d.connectedAt,
    lastSeen: d.lastSeen,
    address: d.address,
});

const event = (name: string, data: unknown) => JSON.stringify({ type: "event", event: name, data });
const deviceEvent = (d: Device) => event("device", deviceInfo(d));
const logEvent = (data: LogEvent) => event("log", data);
const publish = (d: Device, msg: string) => server.publish(viewersTopic(d.id), msg);

const logHistory = (d: Device) =>
    logEvent({ reset: true, entries: [...d.log, ...d.serverLog].sort((a, b) => a.at - b.at).slice(-LOG_MAX) });

/** Keep the newest LOG_MAX entries. */
const trimLog = (log: LogEntry[]) => log.splice(0, Math.max(0, log.length - LOG_MAX));

function addServerLog(d: Device, level: LogLevel, message: string): void {
    const entry: LogEntry = { id: nextServerLogId++, origin: "server", at: Date.now(), level, section: "Device", message };
    d.serverLog.push(entry);
    trimLog(d.serverLog);
    publish(d, logEvent({ entries: [entry] }));
}

/** Apply a device `log` event to the cache; returns the message to forward to viewers. */
function updateDeviceLog(d: Device, data: LogEvent | undefined, raw: string): string | null {
    if (!data || !Array.isArray(data.entries)) return null;
    if (data.reset) {
        d.log = data.entries.slice(-LOG_MAX);
        return logHistory(d);
    }
    for (const e of data.entries) {
        const i = d.log.findIndex((x) => x.id === e.id);
        if (i >= 0) d.log[i] = e;
        else d.log.push(e);
    }
    trimLog(d.log);
    return raw;
}

const errorResponse = (id: unknown, method: string, error: string, code: number) =>
    JSON.stringify({ type: "response", id, method, ok: false, error, code });

function sendToViewer(viewer: Socket, msg: string): void {
    if (viewer.readyState === WebSocket.OPEN) viewer.send(msg);
}

function failPending(predicate: (p: Pending) => boolean, error: string, code: number, notify = true): void {
    for (const [sid, p] of pending) {
        if (!predicate(p)) continue;
        clearTimeout(p.timer);
        pending.delete(sid);
        if (notify) sendToViewer(p.viewer, errorResponse(p.clientId, p.method, error, code));
    }
}

/** Apply the device's self-reported parameters (hello / status); returns whether any changed. */
function updateDevice(d: Device, fields: Partial<Pick<Device, "role" | "hostname" | "color" | "language">>): boolean {
    let changed = false;
    for (const [key, value] of Object.entries(fields) as [keyof typeof fields, string | undefined][]) {
        if (value === undefined || d[key] === value) continue;
        (d as unknown as Record<string, string>)[key] = value;
        changed = true;
    }
    return changed;
}

function onDeviceMessage(d: Device, raw: string | Buffer): void {
    d.lastSeen = Date.now();
    const text = textOf(raw);
    const msg = parseJsonObject(text);
    if (!msg) return;

    if (msg.type === "response" && typeof msg.id === "number") {
        const p = pending.get(msg.id);
        if (!p || p.deviceId !== d.id) return;
        clearTimeout(p.timer);
        pending.delete(msg.id);
        sendToViewer(p.viewer, JSON.stringify({ ...msg, id: p.clientId }));
        return;
    }

    if (msg.type === "event") {
        if (msg.event === "status") {
            d.statusMsg = text;
            d.status = msg.data as Status;
            d.statusAt = Date.now();
            const role = d.status?.role;
            if (updateDevice(d, { role: isRole(role) ? role : undefined })) publish(d, deviceEvent(d));
        } else if (msg.event === "srtla.stats") {
            d.statsMsg = text;
            d.stats = (msg.data as SrtlaStatsEvent | undefined)?.stats ?? null;
        } else if (msg.event === "log") {
            const forward = updateDeviceLog(d, msg.data as LogEvent | undefined, text);
            if (forward) publish(d, forward);
            return;
        }
        publish(d, text);
        return;
    }

    if (msg.type === "hello") {
        if (msg.id !== d.id) console.warn(`[device ${d.id}] hello announced a different id (${String(msg.id)}) — ignored`);
        // The per-uuid parameters the device reports about itself; a color change
        // re-themes the list dot, a hostname change the display name
        const changed = updateDevice(d, {
            role: isRole(msg.role) ? msg.role : undefined,
            hostname: typeof msg.hostname === "string" && msg.hostname !== "" ? msg.hostname : undefined,
            color: typeof msg.color === "string" && COLOR_RE.test(msg.color) ? msg.color : undefined,
            language: isLanguage(msg.language) ? msg.language : undefined,
        });
        if (changed) publish(d, deviceEvent(d));
    }
}

function onViewerMessage(ws: Socket, deviceId: string, raw: string | Buffer): void {
    const msg = parseJsonObject(textOf(raw));
    if (!msg) {
        ws.send(errorResponse(null, "", "Invalid JSON object", 400));
        return;
    }
    const clientId = msg.id ?? null;
    const method = typeof msg.method === "string" ? msg.method : "";
    if (!method) {
        ws.send(errorResponse(clientId, method, "method is required", 400));
        return;
    }
    const d = devices.get(deviceId);
    if (!d?.ws) {
        ws.send(errorResponse(clientId, method, "device offline", 503));
        return;
    }

    const sid = nextRequestId++;
    const timer = setTimeout(() => {
        pending.delete(sid);
        sendToViewer(ws, errorResponse(clientId, method, "device did not respond", 504));
    }, REQUEST_TIMEOUT_MS);
    pending.set(sid, { deviceId, viewer: ws, clientId, method, timer });
    d.ws.send(JSON.stringify({ id: sid, method, params: msg.params }));
}

// ----------------------------------------------------------------------
// Server dashboards: composed from the modules of connected devices, persisted
// to DASHBOARDS_FILE (created on the first change)
// ----------------------------------------------------------------------
interface DashboardsFile {
	dashboards: ServerDashboard[];
}

/** Read `{x, y, w, h}` from an inbound widget payload, tolerating a legacy
 * v1 `width` (4/6/12) where the row position has no meaning. */
function parseGrid(item: Record<string, unknown>, type: WidgetType): { x: number; y: number; w: number; h: number } {
	const size = WIDGET_SIZE[type];
	const toInt = (v: unknown, fallback: number, name: string) => {
		const n = v === undefined ? fallback : Number(v);
		if (!Number.isInteger(n)) throw new ApiError(`${name} must be an integer`);
		return n;
	};
	const legacyWidth = Number(item.width);
	const w = toInt(item.w, [4, 6, 12].includes(legacyWidth) ? legacyWidth : size.w, "w");
	const x = toInt(item.x, 0, "x");
	const y = toInt(item.y, 0, "y");
	const h = toInt(item.h, size.h, "h");
	if (x < 0 || y < 0 || w < 1 || h < 1) throw new ApiError("Widget position/size must be positive");
	if (x + w > DASH_COLUMNS) throw new ApiError("Widget extends past the grid");
	return { x, y, w, h };
}

function parseWidgets(raw: unknown): ServerDashboardWidget[] {
	if (!Array.isArray(raw)) throw new ApiError("widgets is required");
	return raw.map((w) => {
		const item = (w && typeof w === "object" ? w : {}) as Record<string, unknown>;
		const type = item.type;
		if (typeof type !== "string" || !WIDGET_TYPES.includes(type as WidgetType)) {
			throw new ApiError(`Unknown widget type: ${String(type)}`);
		}
		const independent = INDEPENDENT_WIDGETS.has(type as WidgetType);
		const deviceId = item.deviceId;
		if (deviceId !== undefined && typeof deviceId !== "string") {
			throw new ApiError("Widget deviceId must be a string");
		}
		const grid = parseGrid(item, type as WidgetType);
		const visible = item.visible === true;
		const name = typeof item.name === "string" && item.name ? item.name : type;
		// Preserve a client-assigned id so new widgets keep stable gridstack
		// identity; assign one otherwise.
		const id = typeof item.id === "string" && item.id ? item.id : randomUUID();
		if (independent) {
			// Kick widgets are device-independent: they carry their own data
			// source (channel name, and a chat token for kick-chat).
			const cfg = (item.config && typeof item.config === "object" ? item.config : {}) as Record<string, unknown>;
			const channel = cfg.channel;
			if (typeof channel !== "string" || channel.trim() === "") throw new ApiError("Kick widget needs a config.channel");
			const token = cfg.token;
			if (token !== undefined && typeof token !== "string") throw new ApiError("config.token must be a string");
			const config = { channel: channel.trim(), token: typeof token === "string" ? token : "" };
			return { id, deviceId: typeof deviceId === "string" ? deviceId : "", type: type as WidgetType, name, ...grid, visible, config };
		}
		if (typeof deviceId !== "string" || deviceId === "") throw new ApiError("Widget needs a deviceId");
		if (item.config !== undefined) throw new ApiError("Only kick widgets accept a config");
		return { id, deviceId, type: type as WidgetType, name, ...grid, visible };
	});
}

/** Coerce a raw stored dashboard (v1 `{width}` rows or v2 `{x,y,w,h}`) into the
 * normalized v2 shape. `row` is the running baseline used to lay out v1 rows. */
function normalizeDashboard(raw: Record<string, unknown>, index: number): ServerDashboard {
	const id = typeof raw.id === "string" && raw.id ? raw.id : randomUUID();
	const name = typeof raw.name === "string" && raw.name ? raw.name : `Dashboard ${index + 1}`;
	const columns = Number.isFinite(Number(raw.columns)) && Number(raw.columns) > 0 ? Number(raw.columns) : DASH_COLUMNS;
	const widgetsRaw = Array.isArray(raw.widgets) ? raw.widgets : [];
	let row = 0;   // running baseline for stacking v1 rows
	let migrated = false;
	const widgets: ServerDashboardWidget[] = widgetsRaw.map((rr) => {
		const item = (rr && typeof rr === "object" ? rr : {}) as Record<string, unknown>;
		const type = String(item.type);
		const size = WIDGET_SIZE[(type as WidgetType)] ?? { w: 4, h: 4 };
		const isV1 = item.x === undefined && item.w === undefined && item.width !== undefined;
		let x: number, y: number, w: number, h: number;
		if (isV1) {
			migrated = true;
			const width = Number(item.width);
			w = [4, 6, 12].includes(width) ? width : size.w;
			h = Number.isFinite(Number(item.h)) ? Number(item.h) : size.h;
			x = 0;
			y = row;
			row += h;
		} else {
			x = Number(item.x) || 0;
			y = Number(item.y) || 0;
			w = Number(item.w) || size.w;
			h = Number(item.h) || size.h;
			row = Math.max(row, y + h);
		}
		const independent = INDEPENDENT_WIDGETS.has(type as WidgetType);
		const cfgRaw = (item.config && typeof item.config === "object" ? item.config : {}) as Record<string, unknown>;
		const config = independent && typeof cfgRaw.channel === "string"
			? { channel: cfgRaw.channel, token: typeof cfgRaw.token === "string" ? cfgRaw.token : "" }
			: undefined;
		return {
			id: typeof item.id === "string" && item.id ? item.id : randomUUID(),
			deviceId: typeof item.deviceId === "string" ? item.deviceId : "",
			type: type as WidgetType,
			name: typeof item.name === "string" && item.name ? item.name : type,
			x, y, w, h,
			visible: item.visible !== false,
			...(config ? { config } : {}),
		};
	});
	const storedVersion = Number(raw.version);
	const version = migrated ? 2 : Number.isInteger(storedVersion) ? storedVersion : 1;
	return { id, name, version, widgets, columns };
}

let dashboards: ServerDashboard[] = [];
{
	try {
		const loaded = (await Bun.file(DASHBOARDS_FILE).json()) as DashboardsFile;
		if (loaded && Array.isArray(loaded.dashboards)) {
			dashboards = loaded.dashboards.map((d, i) => normalizeDashboard(d as unknown as Record<string, unknown>, i));
		}
	} catch {
		// No file yet: start empty
	}
}

function saveDashboards(): void {
	const file = Bun.file(DASHBOARDS_FILE);
	file.write(JSON.stringify({ dashboards }, null, 2)).catch((err: unknown) =>
		console.error(`[dashboards] persist ${DASHBOARDS_FILE}:`, err),
	);
}

/** Kick channel widgets needed by the persisted dashboards; fans out to dashboard viewers. */
initWidgetHub((msg) => server.publish(dashboardsTopic, msg));
const syncKick = (): void => syncWidgetHub(dashboards);
syncKick();

class ApiError extends Error {
	constructor(message: string, readonly code = 400) {
		super(message);
	}
}

function dashError(code: number, message: string): Response {
	return Response.json({ ok: false, error: message, code });
}

/** Push a dashboard change to every subscriber of the live dashboards topic, so
 * open dashboards (view/edit pages) re-render without a refresh. */
function broadcastDashboard(d: ServerDashboard): void {
	server.publish(dashboardsTopic, event("dashboards.changed", d));
}

async function dashApi(req: Request, url: URL): Promise<Response> {
	try {
		const m = url.pathname.match(DASH_PATH_RE);
		if (!m) return Response.json({ ok: false, error: "Not found", code: 404 });
		const id = m[1];
		if (!id) {
			if (req.method === "GET") return Response.json({ ok: true, dashboards });
			if (req.method === "POST") {
				const body = (await req.json()) as { name?: unknown; widgets?: unknown };
				const name = typeof body.name === "string" ? body.name.trim() : "";
				if (!name) return dashError(400, "Dashboard needs a name");
				const dashboard: ServerDashboard = {
					id: randomUUID(), name, version: 1, columns: DASH_COLUMNS, widgets: parseWidgets(body.widgets),
				};
				dashboards.push(dashboard);
				saveDashboards();
				syncKick();
				broadcastDashboard(dashboard);
				return Response.json({ ok: true, dashboard, dashboards }, { status: 201 });
			}
			return Response.json({ ok: false, error: "Method not allowed", code: 405 });
		}
		// Mutations need a body (JSON); the device list is a separate GET
		const dashboardsById = dashboards.find((d) => d.id === id);
		if (req.method === "DELETE") {
			if (!dashboardsById) return dashError(404, "Unknown dashboard");
			dashboards = dashboards.filter((d) => d.id !== id);
			saveDashboards();
			syncKick();
			server.publish(dashboardsTopic, event("dashboards.changed", { id, deleted: true }));
			return Response.json({ ok: true, dashboards });
		}
		if (req.method === "PUT") {
			if (!dashboardsById) return dashError(404, "Unknown dashboard");
			const body = (await req.json()) as { name?: unknown; widgets?: unknown; version?: unknown };
			const name = typeof body.name === "string" ? body.name.trim() : "";
			if (!name) return dashError(400, "Dashboard needs a name");
			// Optimistic concurrency: the client must echo the version it based
			// the changes on, or we reject and let it rebase against `current`.
			if (Number(body.version) !== dashboardsById.version) {
				return Response.json({ ok: false, error: "version conflict", current: dashboardsById }, { status: 409 });
			}
			dashboardsById.name = name;
			dashboardsById.widgets = parseWidgets(body.widgets);
			dashboardsById.version += 1;
			saveDashboards();
			syncKick();
			broadcastDashboard(dashboardsById);
			return Response.json({ ok: true, dashboard: dashboardsById, dashboards });
		}
		if (req.method === "GET") {
			if (!dashboardsById) return dashError(404, "Unknown dashboard");
			return Response.json({ ok: true, dashboard: dashboardsById });
		}
		return Response.json({ ok: false, error: "Method not allowed", code: 405 });
	} catch (err: unknown) {
		const code = err instanceof ApiError ? err.code : 500;
		return dashError(code, err instanceof Error ? err.message : "Internal error");
	}
}

// ----------------------------------------------------------------------
// HTTP / WebSocket server
// ----------------------------------------------------------------------
function summaries(): DeviceSummary[] {
    return [...devices.values()]
        .map((d) => ({
            ...deviceInfo(d),
            statusAt: d.statusAt,
            srtla: d.status?.state?.srtla,
            encoder: d.status?.state?.encoder,
            modules: d.status?.modules,
            maxBitrate: d.status?.state?.encoder?.config?.maxBitrate,
            ...(d.stats
                ? {
                      bitrate: d.stats.links.reduce((sum, l) => sum + (l.bitrate_bytes_per_sec || 0), 0),
                      activeLinks: d.stats.active_links,
                      totalLinks: d.stats.total_links,
                  }
                : {}),
        }))
        .sort((a, b) => Number(b.online) - Number(a.online) || a.id.localeCompare(b.id));
}

/** Device connection (`/device`): authenticate by uuid + token, then upgrade. */
function deviceUpgrade(req: Request, url: URL, srv: Bun.Server<WsData>): Response | undefined {
    const id = req.headers.get("x-device-id") ?? url.searchParams.get("id") ?? "";
    const token = req.headers.get("authorization")?.match(/^Bearer\s+(.+)$/i)?.[1] ?? "";
    const address = srv.requestIP(req)?.address ?? "";
    if (!ID_RE.test(id)) return text("Missing or invalid x-device-id", 400);
    if (!deviceAuthorized(id, token)) {
        console.warn(`[device ${id}] rejected: bad token from ${address || "?"}`);
        return text("Unauthorized", 401);
    }
    const role = req.headers.get("x-device-role");
    if (srv.upgrade(req, { data: { kind: "device", id, address, role: isRole(role) ? role : undefined } })) return undefined;
    return upgradeRequired();
}

/** Pages and the viewer socket of one device (`/d/<id>/…`). */
function devicePath(req: Request, url: URL, srv: Bun.Server<WsData>, m: RegExpMatchArray): Response | undefined {
    const [, rawId, slash, ws, page, pageSlash] = m;
    const id = decodeURIComponent(rawId);
    if (!ID_RE.test(id)) return text("Invalid device id", 400);
    const base = `/d/${encodeURIComponent(id)}/`;
    if (ws) {
        if (!originAllowed(req)) return text("Origin not allowed", 403);
        if (srv.upgrade(req, { data: { kind: "viewer", id } })) return undefined;
        return upgradeRequired();
    }
    if (page) return pageSlash ? htmlResponse(page as PageName) : Response.redirect(`${base}${page}/`, 308);
    if (!slash) return Response.redirect(base, 308);
    // Devices without a config file serve the setup wizard instead of the UI
    const setupRequired = devices.get(id)?.status?.setupRequired && !url.searchParams.has("ui");
    return htmlResponse(setupRequired ? "setup" : "index");
}

const server = Bun.serve({
    hostname: HOST,
    port: PORT,

    async fetch(req, srv) {
        const url = new URL(req.url);
        const path = url.pathname;

        if (path === "/healthz") return text("ok");
        if (path === "/device") return deviceUpgrade(req, url, srv);
        if (!uiAuthorized(req)) return unauthorized();

        if (path === "/") return htmlResponse("devices");
        if (path === "/api/devices") return Response.json(summaries());
        if (path === "/dashboards/") return htmlResponse("dashboards");
        if (path.startsWith("/api/dashboards")) return dashApi(req, url);
        if (path === "/dashboards/ws") {
            // The dashboard pages' live kick data channel (stats + chat)
            if (!originAllowed(req)) return text("Origin not allowed", 403);
            if (srv.upgrade(req, { data: { kind: "dashboards" } })) return undefined;
            return upgradeRequired();
        }
        if (path.startsWith("/dashboards/view/") || path.startsWith("/dashboards/edit/")) {
            // Both routes serve the merged inline grid editor; the page enables
            // editing when the URL is /dashboards/edit/.
            return htmlResponse("dashboardview");
        }
        if (path.startsWith("/dashboards/add/")) {
            // The dedicated "add widget" page for a single dashboard.
            return htmlResponse("dashboardadd");
        }
        if (path.startsWith("/assets/")) {
            const asset = assets.get(path.slice("/assets/".length));
            return asset
                ? new Response(asset, { headers: { "cache-control": "public, max-age=31536000, immutable" } })
                : notFound();
        }
        const m = path.match(DEVICE_PATH_RE);
        if (m) return devicePath(req, url, srv, m);
        return (await imageResponse(path)) ?? notFound();
    },

    websocket: {
        data: {} as WsData,

        open(ws) {
            const { data } = ws;
            if (data.kind === "dashboards") {
                ws.subscribe(dashboardsTopic);
                ws.send(event("kick.snapshot", widgetHubSnapshot()));
                return;
            }
            if (data.kind === "device") {
                const d = deviceFor(data.id);
                if (d.ws) d.ws.close(4001, "replaced by a new connection");
                d.ws = ws;
                d.address = data.address;
                d.role = data.role ?? d.role;
                d.connectedAt = d.lastSeen = Date.now();
                console.log(`[device ${d.id}] connected from ${data.address}`);
                publish(d, deviceEvent(d));
                addServerLog(d, "info", translate(d.language, "srv.online", data.address));
                return;
            }
            // Viewers of never-seen devices must not grow the registry
            const d = devices.get(data.id) ?? newDevice(data.id);
            ws.subscribe(viewersTopic(d.id));
            ws.send(deviceEvent(d));
            ws.send(logHistory(d));
            if (d.statusMsg) ws.send(d.statusMsg);
            if (d.statsMsg) ws.send(d.statsMsg);
        },

        message(ws, raw) {
            const { data } = ws;
            if (data.kind === "dashboards") return;   // the hub pushes only
            if (data.kind === "viewer") return onViewerMessage(ws, data.id, raw);
            const d = devices.get(data.id);
            if (d && d.ws === ws) onDeviceMessage(d, raw);
        },

        close(ws, code, reason) {
            const { data } = ws;
            if (data.kind === "dashboards") return;
            if (data.kind === "viewer") {
                failPending((p) => p.viewer === ws, "", 0, false);
                return;
            }
            const d = devices.get(data.id);
            if (!d || d.ws !== ws) return;   // an older, replaced connection
            d.ws = null;
            d.statsMsg = undefined;   // live telemetry; viewers clear it on the offline device event
            d.stats = undefined;
            const why = `${code}${reason ? `: ${reason}` : ""}`;
            console.log(`[device ${d.id}] disconnected (${why})`);
            failPending((p) => p.deviceId === d.id, "device disconnected", 503);
            publish(d, deviceEvent(d));
            addServerLog(d, "warn", translate(d.language, "srv.offline", why));
        },
    },
});

// A device entry is dropped from the list once it has been silent for this long
// (lastSeen covers every frame received from the device, refreshed on connect).
setInterval(() => {
    const now = Date.now();
    for (const d of [...devices.values()]) {
        const seen = d.lastSeen ?? d.connectedAt ?? 0;   // never-heard-from phantoms use epoch 0
        if (now - seen <= STALE_DEVICE_MS) continue;
        d.ws?.close(4000, "removed after inactivity");
        devices.delete(d.id);
        failPending((p) => p.deviceId === d.id, "device disconnected", 503);
        publish(d, deviceEvent(d));
        console.log(`[device ${d.id}] removed: no heartbeat for >${STALE_DEVICE_MS / 60000} minutes`);
    }
}, PRUNE_INTERVAL_MS);

console.log(`SRTLA control server on http://${HOST}:${server.port}/`);
console.log(`Relays connect with: --remote ws://<this-host>:${server.port}/device`);
if (NO_AUTH) console.warn("WARNING: --no-auth — anyone can register devices and control them.");
