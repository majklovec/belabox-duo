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
 *   modems.enable|disable|reset|connect|disconnect {index}
 *   srtla.status, srtla.start {listenPort, remoteHost, remotePort}, srtla.stop, srtla.reload
 *   pipelines.list
 *   encoder.status, encoder.start {pipeline, host, port, maxBitrate?, latency?, delay?, streamid?,
 *                                  audioSource?, audioCodec? ("aac"|"opus"), bitrateOverlay?},
 *   encoder.stop, encoder.bitrate {maxBitrate}
 *   stream.start {pipeline, remoteHost, remotePort, listenPort?, ...same encoder options},
 *   stream.stop   (combined devices: srtla_send + belacoder in one action)
 *   autostart.set {enabled}   resume the last stream when the service starts
 *
 * Methods are limited by the device role (--role): relay → modems/srtla/reconfigure,
 * encoder → pipelines/encoder, combined → everything plus stream.*.
 *
 * The same protocol is spoken over the outbound remote connection (see remote.ts).
 */
import type { Server, ServerWebSocket } from "bun";
import index from "../public/index.html";
import {
	ALLOWED_ORIGINS,
	API_HOST,
	API_PORT,
	HAS_ENCODER,
	HAS_RELAY,
	PIPELINES_DIR,
	RELOAD_MODE,
	ROLE,
	UPLINKS_FILE,
} from "./config";
import {
	AUDIO_CODECS,
	AUDIO_DEFAULT,
	type AudioCodec,
	type EncoderConfig,
	encoderStatus,
	listAudioSources,
	listPipelines,
	MAX_BITRATE_KBPS,
	MIN_BITRATE_KBPS,
	setEncoderBitrate,
	startEncoder,
	stopEncoder,
} from "./encoder";
import {
	connectModem,
	detectModems,
	disconnectModem,
	resetModem,
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
import { cancelAutostart, setAutostart, startCombined, stopCombined } from "./stream";

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

function optionalInt(p: Params, key: string, fallback: number, min: number, max: number): number {
	const v = p[key];
	if (v === undefined || v === null || v === "") return fallback;
	const n = Number(v);
	if (!Number.isInteger(n) || n < min || n > max) {
		throw new ApiError(`${key} must be an integer between ${min} and ${max}`);
	}
	return n;
}

function requirePort(p: Params, key: string): string {
	if (p[key] === undefined || p[key] === "") throw new ApiError(`${key} is required`);
	return String(optionalInt(p, key, 0, 1, 65535));
}

/** Hostnames / IPs only — anything else could be mistaken for a CLI flag by the child process. */
function requireHost(p: Params, key: string): string {
	const v = requireString(p, key);
	if (!/^[A-Za-z0-9[][A-Za-z0-9.:_\[\]-]*$/.test(v)) throw new ApiError(`${key} is not a valid host`);
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
		role: ROLE,
		state: {
			selection: state.selection,
			srtla: srtlaStatus(),
			encoder: encoderStatus(),
			stream: state.stream,
			srtlaTarget: state.srtlaTarget,
			autostart: !!state.autostart,
		},
		interfaces: all,
		// Encoder-only devices do no bonding and have no modems to manage
		selected: HAS_RELAY ? await resolveSelection(all) : [],
		modems: HAS_RELAY ? await detectModems() : [],
		audioSources: HAS_ENCODER ? await listAudioSources() : [],
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

function parseEncoderConfig(p: Params, host: string, port: string): EncoderConfig {
	const prev = state.encoder.config;
	const streamid = p.streamid === undefined || p.streamid === "" ? undefined : requireString(p, "streamid");
	const audioSource = p.audioSource === undefined || p.audioSource === ""
		? prev?.audioSource ?? AUDIO_DEFAULT
		: requireString(p, "audioSource");
	const audioCodec = (p.audioCodec ?? prev?.audioCodec ?? "aac") as AudioCodec;
	if (!AUDIO_CODECS.includes(audioCodec)) throw new ApiError(`audioCodec must be one of ${AUDIO_CODECS.join(", ")}`);
	if (p.bitrateOverlay !== undefined && typeof p.bitrateOverlay !== "boolean") {
		throw new ApiError("bitrateOverlay must be a boolean");
	}
	return {
		pipeline: requireString(p, "pipeline"),
		host,
		port,
		maxBitrate: optionalInt(p, "maxBitrate", prev?.maxBitrate ?? 5000, MIN_BITRATE_KBPS, MAX_BITRATE_KBPS),
		latency: optionalInt(p, "latency", prev?.latency ?? 2000, 100, 10_000),
		delay: optionalInt(p, "delay", prev?.delay ?? 0, -2000, 2000),
		streamid,
		audioSource,
		audioCodec,
		bitrateOverlay: (p.bitrateOverlay as boolean | undefined) ?? prev?.bitrateOverlay ?? false,
	};
}

async function startEncoderChecked(cfg: EncoderConfig) {
	try {
		return await startEncoder(cfg);
	} catch (e: unknown) {
		const msg = errorMessage(e);
		throw new ApiError(msg, /already running/.test(msg) ? 409 : /pipeline|audio/i.test(msg) ? 400 : 500);
	}
}

/** Combined devices: bring up srtla_send, then point belacoder at it. */
async function startStream(p: Params) {
	const remoteHost = requireHost(p, "remoteHost");
	const remotePort = requirePort(p, "remotePort");
	const listenPort = String(optionalInt(p, "listenPort", Number(state.stream?.listenPort ?? 9000), 1, 65535));
	const cfg = parseEncoderConfig(p, "127.0.0.1", listenPort);
	cancelAutostart();
	try {
		await startCombined({ remoteHost, remotePort, listenPort }, cfg);
	} catch (e: unknown) {
		const msg = errorMessage(e);
		throw new ApiError(msg, /already/.test(msg) ? 409 : /pipeline|audio/i.test(msg) ? 400 : 500);
	}
	return { srtla: srtlaStatus(), encoder: encoderStatus() };
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

	"srtla.status": () => ({ srtla: srtlaStatus() }),

	"srtla.start": async (p) => {
		cancelAutostart();
		const listenPort = requirePort(p, "listenPort");
		const remoteHost = requireHost(p, "remoteHost");
		const remotePort = requirePort(p, "remotePort");
		try {
			return { srtla: await startSrtla(listenPort, remoteHost, remotePort) };
		} catch (e: unknown) {
			throw new ApiError(errorMessage(e), 409);
		}
	},

	"srtla.stop": async () => {
		cancelAutostart();
		await stopSrtla();
		return { srtla: srtlaStatus() };
	},

	"srtla.reload": async () => {
		await reloadSrtla();
		return { srtla: srtlaStatus() };
	},

	"pipelines.list": async () => ({ dir: PIPELINES_DIR, pipelines: await listPipelines() }),

	"encoder.status": () => ({ encoder: encoderStatus() }),

	"encoder.start": async (p) => {
		cancelAutostart();
		const cfg = parseEncoderConfig(p, requireHost(p, "host"), requirePort(p, "port"));
		return { encoder: await startEncoderChecked(cfg) };
	},

	"encoder.stop": async () => {
		cancelAutostart();
		await stopEncoder();
		return { encoder: encoderStatus() };
	},

	"encoder.bitrate": async (p) => {
		if (p.maxBitrate === undefined) throw new ApiError("maxBitrate is required");
		const kbps = optionalInt(p, "maxBitrate", 0, MIN_BITRATE_KBPS, MAX_BITRATE_KBPS);
		return { encoder: await setEncoderBitrate(kbps) };
	},

	"stream.start": startStream,

	"stream.stop": async () => {
		cancelAutostart();
		await stopCombined();
		return { srtla: srtlaStatus(), encoder: encoderStatus() };
	},

	"autostart.set": async (p) => {
		if (typeof p.enabled !== "boolean") throw new ApiError("enabled must be a boolean");
		await setAutostart(p.enabled);
		return { autostart: !!state.autostart };
	},
};

function methodAllowed(name: string): boolean {
	if (name.startsWith("stream.")) return ROLE === "combined";
	if (name.startsWith("encoder.") || name === "pipelines.list") return HAS_ENCODER;
	if (name.startsWith("modems.") || name.startsWith("srtla.") || name === "reconfigure") return HAS_RELAY;
	return true;
}

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
		if (!methodAllowed(method)) throw new ApiError(`${method} is not available on ${ROLE} devices`, 409);

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
