#!/usr/bin/env bun
/*
 * SRTLA control server.
 *
 * Devices (relay, encoder, or combined encoder+relay) connect out to this server (`srtla_relay.ts --remote ws(s)://host:port/device`)
 * and operators control them from a browser, using the relay's own web UI
 * (../public) served per device.
 *
 * Endpoints:
 *   GET  /                 device list (server/public/devices.html)
 *   GET  /d/<id>/          relay UI for one device (../public/index.html)
 *   WS   /d/<id>/ws        browser ⇄ device; same protocol as the relay's local /ws
 *   GET  /api/devices      JSON list of known devices
 *   WS   /device           device connections (Authorization: Bearer <token>, x-device-id: <id>,
 *                          x-device-role: relay|encoder|combined)
 *   GET  /healthz          liveness (no auth)
 *
 * Browser requests `{id, method, params}` are forwarded to the device with a
 * server-unique id; responses are routed back with the browser's id restored.
 * Device `event` frames (status, srtla.stats, …) fan out to all viewers of that
 * device; the last status and link stats are cached and replayed to new viewers. Viewers also receive
 * `{type:"event", event:"device", data:{id, online, …}}` on connect and whenever
 * the device connects or disconnects.
 *
 * Auth:
 *   devices  shared token (--device-token / SRTLA_DEVICE_TOKEN) and/or a JSON
 *            file of per-device tokens (--devices devices.json: {"cam1": "token"})
 *   browser  HTTP Basic (--ui-user / SRTLA_UI_USER, default "admin";
 *            --ui-password / SRTLA_UI_PASSWORD)
 *   --no-auth disables both (local testing only).
 *
 * Usage:
 *   SRTLA_DEVICE_TOKEN=devsecret SRTLA_UI_PASSWORD=uipass bun server/server.ts --port 8090
 */
import type { ServerWebSocket } from "bun";
import { createHash, timingSafeEqual } from "node:crypto";
import { arg, argFail, flag, intArg } from "./src/args";
import type { DeviceInfo, DeviceSummary, Role, SrtlaStats, SrtlaStatsEvent, Status } from "./public/types";

const PORT         = intArg("--port", 8090, 1, 65535);
const HOST         = arg("--host", "0.0.0.0");
const DEVICE_TOKEN = arg("--device-token", process.env.SRTLA_DEVICE_TOKEN ?? "");
const DEVICES_FILE = arg("--devices");
const UI_USER      = arg("--ui-user", process.env.SRTLA_UI_USER ?? "admin");
const UI_PASSWORD  = arg("--ui-password", process.env.SRTLA_UI_PASSWORD ?? "");
const NO_AUTH      = flag("--no-auth");

const REQUEST_TIMEOUT_MS = 60_000;
const ID_RE = /^[\w.-]{1,64}$/;
const ROLES: readonly Role[] = ["relay", "encoder", "combined"];
const asRole = (v: unknown): Role | undefined => (ROLES as readonly unknown[]).includes(v) ? (v as Role) : undefined;
const viewersTopic = (id: string) => `viewers:${id}`;

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
    new Response("Authentication required\n", {
        status: 401,
        headers: { "www-authenticate": 'Basic realm="SRTLA control", charset="UTF-8"' },
    });

/** Reject cross-site pages driving the browser socket (browsers always send Origin). */
function sameOrigin(req: Request): boolean {
    const origin = req.headers.get("origin");
    if (!origin) return true;
    try {
        return new URL(origin).host === req.headers.get("host");
    } catch {
        return false;
    }
}

// ----------------------------------------------------------------------
// Frontend (bundled once at startup so it can sit behind auth)
// ----------------------------------------------------------------------
interface Page { html: string; }
const assets = new Map<string, Blob>();

async function buildPage(entry: string): Promise<Page> {
    const result = await Bun.build({
        entrypoints: [entry],
        target: "browser",
        minify: true,
        publicPath: "/assets/",
        naming: { asset: "[name]-[hash].[ext]", chunk: "[name]-[hash].[ext]", entry: "[name]-[hash].[ext]" },
    });
    if (!result.success) {
        for (const l of result.logs) console.error(l);
        throw new Error(`Failed to bundle ${entry}`);
    }
    let html = "";
    for (const out of result.outputs) {
        if (out.path.endsWith(".html")) html = await out.text();
        else assets.set(out.path.replace(/^\.\//, ""), out);
    }
    return { html };
}

const devicesPage = await buildPage(new URL("./public/devices.html", import.meta.url).pathname);
const devicePage  = await buildPage(new URL("./public/index.html", import.meta.url).pathname);

const htmlResponse = (page: Page) =>
    new Response(page.html, { headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-cache" } });

// ----------------------------------------------------------------------
// Device registry and request routing
// ----------------------------------------------------------------------
type WsData =
    | { kind: "device"; id: string; address: string; role?: Role }
    | { kind: "viewer"; id: string };
type Socket = ServerWebSocket<WsData>;

interface Device {
    id: string;
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
}

interface Pending {
    deviceId: string;
    viewer: Socket;
    clientId: unknown;
    method: string;
    timer: ReturnType<typeof setTimeout>;
}

const devices = new Map<string, Device>();
const pending = new Map<number, Pending>();
let nextRequestId = 1;

const deviceFor = (id: string): Device => {
    let d = devices.get(id);
    if (!d) devices.set(id, (d = { id, ws: null }));
    return d;
};

const deviceInfo = (d: Device): DeviceInfo => ({
    id: d.id,
    role: d.role,
    online: d.ws !== null,
    connectedAt: d.connectedAt,
    lastSeen: d.lastSeen,
    address: d.address,
});

const deviceEvent = (d: Device) => JSON.stringify({ type: "event", event: "device", data: deviceInfo(d) });

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

function parseObject(raw: string | Buffer): Record<string, unknown> | null {
    try {
        const msg: unknown = JSON.parse(typeof raw === "string" ? raw : raw.toString());
        return msg && typeof msg === "object" && !Array.isArray(msg) ? (msg as Record<string, unknown>) : null;
    } catch {
        return null;
    }
}

function onDeviceMessage(d: Device, raw: string | Buffer): void {
    d.lastSeen = Date.now();
    const msg = parseObject(raw);
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
        const text = typeof raw === "string" ? raw : raw.toString();
        if (msg.event === "status") {
            d.statusMsg = text;
            d.status = msg.data as Status;
            d.statusAt = Date.now();
            const role = asRole(d.status?.role);
            if (role && role !== d.role) {
                d.role = role;
                server.publish(viewersTopic(d.id), deviceEvent(d));
            }
        }
        if (msg.event === "srtla.stats") {
            d.statsMsg = text;
            d.stats = (msg.data as SrtlaStatsEvent | undefined)?.stats ?? null;
        }
        server.publish(viewersTopic(d.id), text);
        return;
    }

    if (msg.type === "hello") {
        if (msg.id !== d.id) console.warn(`[device ${d.id}] hello announced a different id (${String(msg.id)}) — ignored`);
        const role = asRole(msg.role);
        if (role && role !== d.role) {
            d.role = role;
            server.publish(viewersTopic(d.id), deviceEvent(d));
        }
    }
}

function onViewerMessage(ws: Socket, deviceId: string, raw: string | Buffer): void {
    const msg = parseObject(raw);
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
// HTTP / WebSocket server
// ----------------------------------------------------------------------
function summaries(): DeviceSummary[] {
    return [...devices.values()]
        .map((d) => ({
            ...deviceInfo(d),
            statusAt: d.statusAt,
            srtla: d.status?.state.srtla,
            encoder: d.status?.state.encoder,
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

const server = Bun.serve({
    hostname: HOST,
    port: PORT,

    async fetch(req, srv) {
        const url = new URL(req.url);
        const path = url.pathname;

        if (path === "/healthz") return new Response("ok\n");

        if (path === "/device") {
            const id = req.headers.get("x-device-id") ?? url.searchParams.get("id") ?? "";
            const token = req.headers.get("authorization")?.match(/^Bearer\s+(.+)$/i)?.[1] ?? "";
            if (!ID_RE.test(id)) return new Response("Missing or invalid x-device-id\n", { status: 400 });
            if (!deviceAuthorized(id, token)) {
                console.warn(`[device ${id}] rejected: bad token from ${srv.requestIP(req)?.address ?? "?"}`);
                return new Response("Unauthorized\n", { status: 401 });
            }
            const address = srv.requestIP(req)?.address ?? "";
            const role = asRole(req.headers.get("x-device-role"));
            if (srv.upgrade(req, { data: { kind: "device", id, address, role } })) return undefined;
            return new Response("Expected a WebSocket upgrade\n", { status: 426 });
        }

        if (!uiAuthorized(req)) return unauthorized();

        if (path === "/") return htmlResponse(devicesPage);
        if (path === "/api/devices") return Response.json(summaries());

        if (path.startsWith("/assets/")) {
            const asset = assets.get(path.slice("/assets/".length));
            return asset
                ? new Response(asset, { headers: { "cache-control": "public, max-age=31536000, immutable" } })
                : new Response("Not found\n", { status: 404 });
        }

        const m = path.match(/^\/d\/([^/]+)(\/(ws)?)?$/);
        if (m) {
            const id = decodeURIComponent(m[1]);
            if (!ID_RE.test(id)) return new Response("Invalid device id\n", { status: 400 });
            if (!m[2]) return Response.redirect(`/d/${encodeURIComponent(id)}/`, 308);
            if (!m[3]) return htmlResponse(devicePage);
            if (!sameOrigin(req)) return new Response("Origin not allowed\n", { status: 403 });
            if (srv.upgrade(req, { data: { kind: "viewer", id } })) return undefined;
            return new Response("Expected a WebSocket upgrade\n", { status: 426 });
        }

        return new Response("Not found\n", { status: 404 });
    },

    websocket: {
        data: {} as WsData,

        open(ws) {
            const { data } = ws;
            if (data.kind === "device") {
                const d = deviceFor(data.id);
                if (d.ws) d.ws.close(4001, "replaced by a new connection");
                d.ws = ws;
                d.address = data.address;
                d.role = data.role ?? d.role;
                d.connectedAt = d.lastSeen = Date.now();
                console.log(`[device ${d.id}] connected from ${data.address}`);
                server.publish(viewersTopic(d.id), deviceEvent(d));
                return;
            }
            // Viewers of never-seen devices must not grow the registry
            const d = devices.get(data.id) ?? { id: data.id, ws: null };
            ws.subscribe(viewersTopic(d.id));
            ws.send(deviceEvent(d));
            if (d.statusMsg) ws.send(d.statusMsg);
            if (d.statsMsg) ws.send(d.statsMsg);
        },

        message(ws, raw) {
            const { data } = ws;
            if (data.kind === "device") {
                const d = devices.get(data.id);
                if (d && d.ws === ws) onDeviceMessage(d, raw);
            } else {
                onViewerMessage(ws, data.id, raw);
            }
        },

        close(ws, code, reason) {
            const { data } = ws; 
            if (data.kind === "viewer") {
                failPending((p) => p.viewer === ws, "", 0, false);
                return;
            }
            const d = devices.get(data.id);
            if (!d || d.ws !== ws) return;   // an older, replaced connection
            d.ws = null;
            d.statsMsg = undefined;   // live telemetry; viewers clear it on the offline device event
            d.stats = undefined;
            console.log(`[device ${d.id}] disconnected (${code}${reason ? `: ${reason}` : ""})`);
            failPending((p) => p.deviceId === d.id, "device disconnected", 503);
            server.publish(viewersTopic(d.id), deviceEvent(d));
        },
    },
});

console.log(`SRTLA control server on http://${HOST}:${server.port}/`);
console.log(`Relays connect with: --remote ws://<this-host>:${server.port}/device`);
if (NO_AUTH) console.warn("WARNING: --no-auth — anyone can register devices and control them.");
