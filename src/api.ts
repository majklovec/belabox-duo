/*
 * WebSocket API (Bun.serve) exposing interfaces, modem control, bonding
 * selection and srtla_send management. Also serves the web UI (public/) at `/`.
 *
 * Endpoint: ws://<host>:<port>/ws
 *
 * Client → server (request):
 *   { "id": 1, "method": "modems.toggle", "params": { "iface": "wwan0" } }
 *
 * Server → client (response to a request, `id` echoed back):
 *   { "type": "response", "id": 1, "method": "modems.toggle", "ok": true,  "result": { ... } }
 *   { "type": "response", "id": 1, "method": "modems.toggle", "ok": false, "error": "...", "code": 404 }
 *
 * Server → client (push, sent on connect and whenever state changes):
 *   { "type": "event", "event": "status", "data": { ...same as `status` result... } }
 *
 * Methods:
 *   status, interfaces.list, reconfigure
 *   modems.list, modems.select {modems?|ips?}, modems.toggle {iface}
 *   modems.enable|disable|reset|connect|disconnect {index}, modems.at {index, command}
 *   srtla.status, srtla.start {listenPort, remoteHost, remotePort}, srtla.stop, srtla.reload
 *
 * The same protocol is spoken over the outbound remote connection (see remote.ts).
 */
import type { Server, ServerWebSocket } from "bun";
import index from "../public/index.html";
import { ALLOWED_ORIGINS, API_HOST, API_PORT, RELOAD_MODE, UPLINKS_FILE } from "./config";
import {
	connectModem,
	detectModems,
	disconnectModem,
	resetModem,
	sendAtCommand,
	setModemEnabled,
} from "./modems";
import {
	detectInterfaces,
	isMonitorRunning,
	type ModemConfig,
	reconfigure,
	resolveSelection,
	setSelection,
} from "./routing";
import { reloadSrtla, srtlaStatus, startSrtla, stopSrtla } from "./srtla";
import { onStateChange, state } from "./state";

const WS_PATH = "/ws";
const STATUS_TOPIC = "status";
const BROADCAST_DEBOUNCE_MS = 250;

type Params = Record<string, unknown>;
type Method = (params: Params) => Promise<object> | object;

class ApiError extends Error {
	constructor(message: string, readonly code = 400) {
		super(message);
	}
}

const errorMessage = (err: unknown): string =>
	err instanceof Error ? err.message : String(err);

// ----------------------------------------------------------------------
// Parameter validation
// ----------------------------------------------------------------------
function requireString(p: Params, key: string): string {
	const v = p[key];
	if (typeof v === "number") return String(v);
	if (typeof v === "string" && v) return v;
	throw new ApiError(`${key} is required`);
}

function optionalStringList(p: Params, key: string): string[] | undefined {
	const v = p[key];
	if (v === undefined) return undefined;
	if (!Array.isArray(v) || !v.every((x) => typeof x === "string")) {
		throw new ApiError(`${key} must be an array of strings`);
	}
	return v;
}

function requireModemIndex(p: Params): number {
	const n = Number(p.index);
	if (p.index === undefined || !Number.isInteger(n) || n < 0) {
		throw new ApiError("index must be a non-negative integer");
	}
	return n;
}

// ----------------------------------------------------------------------
// Methods
// ----------------------------------------------------------------------
async function buildStatus() {
	const all = await detectInterfaces();
	return {
		state: { selection: state.selection, srtla: srtlaStatus() },
		interfaces: all,
		selected: await resolveSelection(all),
		modems: await detectModems(),
		uplinksFile: UPLINKS_FILE,
		monitor: { running: isMonitorRunning(), reloadMode: RELOAD_MODE },
	};
}

/** Reconfigure routing/uplinks and reload srtla_send if the uplinks changed. */
async function reconfigureAndReload() {
	const result = await reconfigure();
	if (!result.ok) throw new ApiError(result.error ?? "reconfigure failed", 500);
	if (result.changed) await reloadSrtla();
	return result;
}

async function applySelection(selection: ModemConfig) {
	await setSelection(selection);
	const result = await reconfigureAndReload();
	return {
		selection: state.selection,
		selected: result.selected,
		ips: result.ips,
		uplinksFile: result.uplinksFile,
		changed: result.changed,
	};
}

const modemAction =
	(action: string, fn: (index: number) => Promise<boolean>): Method =>
	async (p) => {
		const index = requireModemIndex(p);
		return { modemIndex: index, action, ok: await fn(index) };
	};

const methods: Record<string, Method> = {
	status: buildStatus,

	"interfaces.list": async () => ({ interfaces: await detectInterfaces() }),

	reconfigure: reconfigureAndReload,

	"modems.list": async () => {
		const all = await detectInterfaces();
		return {
			selection: state.selection,
			selected: await resolveSelection(all),
			modems: await detectModems(),
		};
	},

	"modems.select": async (p) => {
		const modems = optionalStringList(p, "modems");
		const ips = optionalStringList(p, "ips");
		const all = await detectInterfaces();
		const validIfaces = new Set(all.map((i) => i.iface));
		const validIps = new Set(all.map((i) => i.ip));

		const badIfaces = modems?.filter((m) => !validIfaces.has(m)) ?? [];
		if (badIfaces.length) throw new ApiError(`Unknown interfaces: ${badIfaces.join(", ")}`);
		const badIps = ips?.filter((i) => !validIps.has(i)) ?? [];
		if (badIps.length) throw new ApiError(`Unknown IPs: ${badIps.join(", ")}`);

		return applySelection(modems?.length ? { modems } : ips?.length ? { ips } : {});
	},

	"modems.toggle": async (p) => {
		const name = requireString(p, "iface");
		const all = await detectInterfaces();
		if (!all.some((i) => i.iface === name)) {
			throw new ApiError(`Unknown interface: ${name}`, 404);
		}
		const names = new Set((await resolveSelection(all)).map((i) => i.iface));
		if (!names.delete(name)) names.add(name);
		return applySelection({ modems: [...names] });
	},

	// Monitor picks up the resulting netlink events and pushes a status update
	"modems.enable": modemAction("enable", (i) => setModemEnabled(i, true)),
	"modems.disable": modemAction("disable", (i) => setModemEnabled(i, false)),
	"modems.reset": modemAction("reset", resetModem),
	"modems.connect": modemAction("connect", connectModem),
	"modems.disconnect": modemAction("disconnect", disconnectModem),

	"modems.at": async (p) => {
		const index = requireModemIndex(p);
		const command = requireString(p, "command");
		return { modemIndex: index, command, output: await sendAtCommand(index, command) };
	},

	"srtla.status": () => ({ srtla: srtlaStatus() }),

	"srtla.start": async (p) => {
		const listenPort = requireString(p, "listenPort");
		const remoteHost = requireString(p, "remoteHost");
		const remotePort = requireString(p, "remotePort");
		try {
			return { srtla: await startSrtla(listenPort, remoteHost, remotePort) };
		} catch (e: unknown) {
			throw new ApiError(errorMessage(e), 409);
		}
	},

	"srtla.stop": async () => {
		await stopSrtla();
		return { srtla: srtlaStatus() };
	},

	"srtla.reload": async () => {
		await reloadSrtla();
		return { srtla: srtlaStatus() };
	},
};

// ----------------------------------------------------------------------
// Message handling
// ----------------------------------------------------------------------
type Socket = ServerWebSocket<undefined>;

/** Dispatch one request message; returns the serialized response. Transport-agnostic. */
export async function handleRequest(raw: string | Buffer | ArrayBuffer | Uint8Array): Promise<string> {
	let id: unknown = null;
	let method = "";
	try {
		let msg: unknown;
		try {
			msg = JSON.parse(typeof raw === "string" ? raw : new TextDecoder().decode(raw));
		} catch {
			throw new ApiError("Invalid JSON");
		}
		if (!msg || typeof msg !== "object" || Array.isArray(msg)) {
			throw new ApiError("Message must be a JSON object");
		}
		const req = msg as { id?: unknown; method?: unknown; params?: unknown };
		id = req.id ?? null;
		if (typeof req.method !== "string") throw new ApiError("method is required");
		method = req.method;

		const handler = Object.hasOwn(methods, method) ? methods[method] : undefined;
		if (!handler) throw new ApiError(`Unknown method: ${method}`, 404);

		const params =
			req.params && typeof req.params === "object" && !Array.isArray(req.params)
				? (req.params as Params)
				: {};
		const result = await handler(params);
		return JSON.stringify({ type: "response", id, method, ok: true, result });
	} catch (err: unknown) {
		const code = err instanceof ApiError ? err.code : 500;
		if (code >= 500) console.error(`API error (${method || "?"}):`, err);
		return JSON.stringify({ type: "response", id, method, ok: false, error: errorMessage(err), code });
	}
}

async function handleMessage(ws: Socket, raw: string | Buffer): Promise<void> {
	const response = await handleRequest(raw);
	ws.send(response);
}

// ----------------------------------------------------------------------
// Status push (debounced, deduplicated) to every registered sink
// ----------------------------------------------------------------------
export interface StatusSink {
	/** Whether anyone is listening right now (skip building status otherwise). */
	active(): boolean;
	send(msg: string): void;
}

const sinks = new Set<StatusSink>();
let server: Server<undefined> | null = null;
let broadcastTimer: ReturnType<typeof setTimeout> | null = null;
let lastBroadcast = "";
let unsubscribeState: (() => void) | null = null;

export const statusEvent = async (): Promise<string> =>
	JSON.stringify({ type: "event", event: "status", data: await buildStatus() });

function scheduleBroadcast(): void {
	if (broadcastTimer || ![...sinks].some((s) => s.active())) return;
	broadcastTimer = setTimeout(async () => {
		broadcastTimer = null;
		try {
			const msg = await statusEvent();
			if (msg === lastBroadcast) return;
			lastBroadcast = msg;
			for (const sink of sinks) if (sink.active()) sink.send(msg);
		} catch (err: unknown) {
			console.error("Status broadcast failed:", errorMessage(err));
		}
	}, BROADCAST_DEBOUNCE_MS);
}

/** Register a status push target; returns an unregister function. */
export function addStatusSink(sink: StatusSink): () => void {
	sinks.add(sink);
	unsubscribeState ??= onStateChange(scheduleBroadcast);
	return () => sinks.delete(sink);
}

// ----------------------------------------------------------------------
// Server
// ----------------------------------------------------------------------
/**
 * Browsers always send `Origin`; reject cross-site pages so a random website
 * cannot drive the local API. Non-browser clients (no Origin) are allowed.
 */
function isOriginAllowed(req: Request): boolean {
	const origin = req.headers.get("origin");
	if (!origin) return true;
	if (ALLOWED_ORIGINS.includes("*") || ALLOWED_ORIGINS.includes(origin)) return true;
	try {
		return new URL(origin).host === req.headers.get("host");
	} catch {
		return false;
	}
}

export function startApiServer(): void {
	server = Bun.serve({
		hostname: API_HOST,
		port: API_PORT,
		// Web UI from public/ — Bun bundles the HTML's scripts and styles on the fly
		routes: { "/": index },
		fetch(req, srv) {
			if (new URL(req.url).pathname !== WS_PATH) {
				return new Response("Not found\n", { status: 404 });
			}
			if (!isOriginAllowed(req)) {
				return new Response("Origin not allowed\n", { status: 403 });
			}
			if (srv.upgrade(req)) return undefined;
			return new Response("Expected a WebSocket upgrade\n", {
				status: 426,
				headers: { upgrade: "websocket" },
			});
		},
		websocket: {
			async open(ws) {
				ws.subscribe(STATUS_TOPIC);
				try {
					ws.send(await statusEvent());
				} catch (err: unknown) {
					console.error("Initial status failed:", errorMessage(err));
				}
			},
			message(ws, raw) {
				void handleMessage(ws, raw);
			},
		},
	});

	addStatusSink({
		active: () => (server?.subscriberCount(STATUS_TOPIC) ?? 0) > 0,
		send: (msg) => server?.publish(STATUS_TOPIC, msg),
	});

	const url = `ws://${API_HOST}:${server.port}${WS_PATH}`;
	console.log(`SRTLA web UI on http://${API_HOST}:${server.port}/`);
	console.log(`SRTLA bonding WebSocket API listening on ${url}`);
	console.log(`Try:  bunx wscat -c ${url}  then send {"id":1,"method":"status"}`);
}
