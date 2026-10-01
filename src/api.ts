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
 *   { "type": "event", "event": "log", "data": { "reset"?: true, "entries": [LogEntry, ...] } }
 *     (full history with `reset` on connect, then each new or updated entry; see logMessages.ts)
 *   { "type": "event", "event": "srtla.stats", "data": { "at": <ms>, "stats": {...} | null } }
 *     (~1 Hz while srtla_send runs with a control socket; `null` when it stops)
 *
 * Methods:
 *   status, interfaces.list, reconfigure, log.list
 *   modems.list, modems.select {modems?|ips?}, modems.toggle {iface}
 *   modems.enable|disable|reset|connect|disconnect {index}
 *   srtla.status, srtla.start {listenPort, remoteHost, remotePort}, srtla.stop, srtla.reload
 *   srtla.stats   latest per-link telemetry from srtla_send's control socket
 *   srtla.options {mode? ("classic"|"enhanced"), quality? (bool)}   applied live when possible
 *   pipelines.list
 *   pipelines.repositories.add {repository}, pipelines.repositories.remove {repository}
 *   pipelines.repositories.updateAll
 *   encoder.status, encoder.start {pipeline, host, port, maxBitrate?, latency?, delay?, streamid?,
 *                                  audioSource?, audioCodec? ("aac"|"opus"), bitrateOverlay?},
 *   encoder.stop, encoder.bitrate {maxBitrate}
 *   stream.start {pipeline, remoteHost, remotePort, listenPort?, ...same encoder options},
 *   stream.stop   (combined devices: srtla_send + belacoder in one action)
 *   autostart.set {enabled}   resume the last stream when the service starts
 *
 * Methods are limited by the device role (--role): relay → modems/srtla/reconfigure,
 * encoder → pipelines/encoder, combined → everything plus stream.*.
 * Methods that change something are recorded in the event log (success or failure); their
 * responses carry `"logged": true` so clients do not log them a second time.
 *
 * The same protocol is spoken over the outbound remote connection (see remote.ts).
 */
import { randomUUID } from "node:crypto";
import type { Server, ServerWebSocket } from "bun";
import index from "../public/index.html";
import settings from "../public/settings.html";
import setup from "../public/setup.html";
import {
	ALLOWED_ORIGINS,
	API_HOST,
	API_PORT,
	HAS_ENCODER,
	HAS_RELAY,
	PIPELINES_DIR,
	RELOAD_MODE,
	ROLES,
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
import { removePipelineRepository, syncPipelineRepository } from "./git";
import { applyRemoteSettings } from "./remote";
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
import { logEntries, logEvent, onLogEntry } from "./eventlog";
import { isLoggedMethod, type LogEvent, methodLog } from "./logMessages";
import { reloadSrtla, setSrtlaOptions, srtlaStatus, startSrtla, stopSrtla } from "./srtla";
import {
	latestSrtlaStats,
	onSrtlaControlChange,
	onSrtlaStats,
	SRTLA_MODES,
	type SrtlaMode,
	type SrtlaStatsEvent,
	srtlaControlState,
} from "./srtlaControl";
import type { SrtlaOptions } from "./state";
import { completeSetup, onStateChange, saveState, setupRequired, state } from "./state";
import { cancelAutostart, setAutostart, startCombined, stopCombined } from "./stream";

const WS_PATH = "/ws";
const STATUS_TOPIC = "status";

// Role diagrams on the setup wizard (e.g. /img/encoder.svg)
const IMG_PATH_RE = /^\/img\/[a-zA-Z0-9_-]+\.svg$/;
async function svgResponse(path: string): Promise<Response> {
	const file = Bun.file(new URL(`../public${path}`, import.meta.url));
	return (await file.exists())
		? new Response(file, { headers: { "content-type": "image/svg+xml; charset=utf-8", "cache-control": "no-cache" } })
		: new Response("Not found\n", { status: 404 });
}
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

function optionalSettingString(p: Params, key: string, current: string | undefined): string | undefined {
	const value = p[key];
	if (value === undefined) return current;
	if (typeof value !== "string") throw new ApiError(`${key} must be a string`);
	return value.trim() || undefined;
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
		setupRequired,
		state: {
			selection: state.selection,
			srtla: srtlaStatus(),
			encoder: encoderStatus(),
			stream: state.stream,
			srtlaTarget: state.srtlaTarget,
			srtlaOptions: state.srtlaOptions ?? {},
			autostart: !!state.autostart,
		},
		interfaces: all,
		// Encoder-only devices do no bonding and have no modems to manage
		selected: HAS_RELAY ? await resolveSelection(all) : [],
		modems: HAS_RELAY ? await detectModems() : [],
		audioSources: HAS_ENCODER ? await listAudioSources() : [],
		uplinksFile: UPLINKS_FILE,
		srtlaControl: srtlaControlState(),
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

	"setup.get": async () => ({
		required: setupRequired,
		hostname: state.settings?.hostname ?? "",
		color: state.settings?.color ?? "#0f1115",
		pipelines: await listPipelines(),
		audioSources: await listAudioSources(),
	}),

	"setup.complete": async (p) => {
		if (!setupRequired) throw new ApiError("Setup has already been completed", 409);
		const role = requireString(p, "role");
		if (!(ROLES as readonly string[]).includes(role)) {
			throw new ApiError(`role must be one of ${ROLES.join(", ")}`);
		}
		const hostname = requireString(p, "hostname").trim();
		if (!/^[A-Za-z0-9][A-Za-z0-9.-]{0,62}$/.test(hostname)) {
			throw new ApiError("hostname must contain only letters, numbers, dots and hyphens");
		}
		// The uuid is auto-assigned from the start (state.ts) and never changes afterwards
		const uuid = state.settings?.uuid ?? randomUUID();
		const color = requireString(p, "color");
		if (!/^#[0-9a-fA-F]{6}$/.test(color)) {
			throw new ApiError("color must be a six-digit hexadecimal color");
		}
		const remoteUrl = optionalSettingString(p, "remoteUrl", undefined);
		if (remoteUrl !== undefined && !/^wss?:\/\/.+/.test(remoteUrl)) {
			throw new ApiError("remoteUrl must be a ws:// or wss:// URL");
		}
		const remoteToken = optionalSettingString(p, "remoteToken", undefined);

		const hasEncoder = role !== "relay";
		const hasRelay = role !== "encoder";
		let relayTarget: { listenPort: string; remoteHost: string; remotePort: string } | undefined;
		if (hasRelay) {
			relayTarget = {
				listenPort: requirePort(p, "listenPort"),
				remoteHost: requireHost(p, "srtlaRemoteHost"),
				remotePort: requirePort(p, "srtlaRemotePort"),
			};
			const mode = requireString(p, "srtlaMode");
			if (!(SRTLA_MODES as readonly string[]).includes(mode)) {
				throw new ApiError(`srtlaMode must be one of ${SRTLA_MODES.join(", ")}`);
			}
			if (typeof p.srtlaQuality !== "boolean") throw new ApiError("srtlaQuality must be a boolean");
			state.srtlaOptions = { mode: mode as SrtlaMode, quality: p.srtlaQuality };
			state.srtlaTarget = relayTarget;
		}

		if (hasEncoder) {
			const encoderPort = role === "combined"
				? relayTarget!.listenPort
				: requirePort(p, "encoderPort");
			const encoderHost = role === "combined"
				? "127.0.0.1"
				: requireHost(p, "encoderHost");
			state.encoder = { running: false, config: parseEncoderConfig(p, encoderHost, encoderPort) };
		}
		if (role === "combined") state.stream = relayTarget;
		state.autostart = p.autostart === true;
		state.settings = {
			...state.settings,
			uuid,
			hostname,
			role,
			color,
			remoteUrl,
			remoteToken,
		};
		await completeSetup();
		// Start (or re-target) the control-server link with the saved endpoint
		if (remoteUrl) applyRemoteSettings(remoteUrl, remoteToken);
		// The routes table is fixed per server instance; swap the server once
		// this response has been flushed (timers run after the microtask that sends it).
		setTimeout(restartApiServer, 0);
		return { completed: true, restartRequired: true };
	},

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

	"srtla.stats": () => latestSrtlaStats(),

	"srtla.options": async (p) => {
		const opts: SrtlaOptions = {};
		if (p.mode !== undefined) {
			if (!(SRTLA_MODES as readonly unknown[]).includes(p.mode)) {
				throw new ApiError(`mode must be one of ${SRTLA_MODES.join(", ")}`);
			}
			opts.mode = p.mode as SrtlaMode;
		}
		if (p.quality !== undefined) {
			if (typeof p.quality !== "boolean") throw new ApiError("quality must be a boolean");
			opts.quality = p.quality;
		}
		if (opts.mode === undefined && opts.quality === undefined) throw new ApiError("mode or quality is required");
		let result: Awaited<ReturnType<typeof setSrtlaOptions>>;
		try {
			result = await setSrtlaOptions(opts);
		} catch (e: unknown) {
			throw new ApiError(errorMessage(e), 502);
		}
		if (!result.applied && srtlaStatus().running) {
			logEvent("warn", "SRTLA", "No control socket; the setting applies on the next start");
		}
		return result;
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

	"settings.get": () => ({
		settings: {
			uuid: state.settings?.uuid ?? "",
			hostname: state.settings?.hostname ?? "",
			role: state.settings?.role ?? "",
			remoteUrl: state.settings?.remoteUrl ?? "",
			hasRemoteToken: !!state.settings?.remoteToken,
			color: state.settings?.color ?? "#0f1115",
			pipelineRepositories: state.settings?.pipelineRepositories ?? [],
		},
		restartRequired: true,
	}),

	"settings.update": async (p) => {
		const current = state.settings ?? {};
		// The uuid is assigned at setup and immutable; the UI only ever echoes it back
		if (p.uuid !== undefined && p.uuid !== current.uuid) {
			throw new ApiError("The device uuid can't be changed");
		}
		const uuid = current.uuid;
		const hostname = optionalSettingString(p, "hostname", current.hostname);
		if (hostname !== undefined && !/^[A-Za-z0-9][A-Za-z0-9.-]{0,62}$/.test(hostname)) {
			throw new ApiError("hostname must contain only letters, numbers, dots and hyphens");
		}
		const role = optionalSettingString(p, "role", current.role);
		if (role !== undefined && !(ROLES as readonly string[]).includes(role)) {
			throw new ApiError(`role must be one of ${ROLES.join(", ")}`);
		}
		const remoteUrl = optionalSettingString(p, "remoteUrl", current.remoteUrl);
		if (remoteUrl !== undefined && !/^wss?:\/\/.+/.test(remoteUrl)) {
			throw new ApiError("remoteUrl must be a ws:// or wss:// URL");
		}
		if (p.remoteToken !== undefined && typeof p.remoteToken !== "string") {
			throw new ApiError("remoteToken must be a string");
		}
		const remoteToken = p.remoteToken === undefined ? current.remoteToken : String(p.remoteToken).trim() || undefined;
		const color = optionalSettingString(p, "color", current.color);
		if (color !== undefined && !/^#[0-9a-fA-F]{6}$/.test(color)) {
			throw new ApiError("color must be a six-digit hexadecimal color");
		}
		const remoteChanged = remoteUrl !== current.remoteUrl || remoteToken !== current.remoteToken;
		state.settings = { ...current, uuid, hostname, role, remoteUrl, remoteToken, color };
		await saveState();
		// Every save re-registers the device on the control server — re-dialing to
		// the (possibly new) URL so changed token/role/hostname are picked up live.
		if (remoteUrl || remoteChanged) {
			applyRemoteSettings(remoteUrl ?? "", remoteToken);
			let target = remoteUrl!;
			try {
				const u = new URL(remoteUrl!);
				u.username = u.password = "";
				target = u.toString();
			} catch { /* leave as-is */ }
			logEvent("info", "Settings", `Settings saved; reconnecting to ${target}`);
		} else {
			logEvent("info", "Settings", "Settings saved");
		}
		return {
			settings: {
				uuid: uuid ?? "",
				hostname: hostname ?? "",
				role: role ?? "",
				remoteUrl: remoteUrl ?? "",
				hasRemoteToken: !!remoteToken,
				color: color ?? "#0f1115",
				pipelineRepositories: state.settings.pipelineRepositories ?? [],
			},
			restartRequired: true,
		};
	},

	"pipelines.repositories.add": async (p) => {
		const repository = requireString(p, "repository").trim();
		const result = await syncPipelineRepository(repository, PIPELINES_DIR);
		const repositories = new Set(state.settings?.pipelineRepositories ?? []);
		repositories.add(repository);
		state.settings = { ...state.settings, pipelineRepositories: [...repositories].sort() };
		await saveState();
		return { repositories: state.settings.pipelineRepositories, result };
	},

	"pipelines.repositories.remove": async (p) => {
		const repository = requireString(p, "repository").trim();
		await removePipelineRepository(repository, PIPELINES_DIR);
		state.settings = {
			...state.settings,
			pipelineRepositories: (state.settings?.pipelineRepositories ?? []).filter((item) => item !== repository),
		};
		await saveState();
		return { repositories: state.settings.pipelineRepositories };
	},

	"pipelines.repositories.updateAll": async () => {
		const repositories = state.settings?.pipelineRepositories ?? [];
		const results = [];
		for (const repository of repositories) {
			results.push(await syncPipelineRepository(repository, PIPELINES_DIR));
		}
		return { repositories, results };
	},

	"log.list": () => ({ entries: logEntries() }),
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
	let logged = false;
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

		const params: Params =
			req.params && typeof req.params === "object" && !Array.isArray(req.params)
				? (req.params as Params)
				: {};
		logged = isLoggedMethod(method);
		const result = await handler(params);
		if (logged) {
			const { section, done } = methodLog(method);
			logEvent("info", section, done(params));
		}
		return JSON.stringify({ type: "response", id, method, ok: true, result, ...(logged ? { logged } : {}) });
	} catch (err: unknown) {
		const code = err instanceof ApiError ? err.code : 500;
		if (code >= 500) console.error(`API error (${method || "?"}):`, err);
		if (logged) {
			const { section, action } = methodLog(method);
			logEvent("error", section, `${action} failed: ${errorMessage(err)}`);
		}
		return JSON.stringify({
			type: "response", id, method, ok: false, error: errorMessage(err), code, ...(logged ? { logged } : {}),
		});
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
	/** Minimum spacing of `srtla.stats` pushes (0 = every update, negative = never). */
	statsIntervalMs?: number;
}

const sinks = new Set<StatusSink>();
let server: Server<undefined> | null = null;
let broadcastTimer: ReturnType<typeof setTimeout> | null = null;
let lastBroadcast = "";
let unsubscribeState: (() => void) | null = null;
const lastStatsSent = new Map<StatusSink, number>();
// srtla_send pushes about once a second; allow for jitter so a 2 s interval is not every 3 s
const STATS_JITTER_MS = 250;

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

const logPayload = (data: LogEvent): string =>
	JSON.stringify({ type: "event", event: "log", data });

/** Full event log, sent to every new connection. */
export const logHistoryEvent = (): string => logPayload({ reset: true, entries: logEntries() });

export const statsEvent = (ev: SrtlaStatsEvent = latestSrtlaStats()): string =>
	JSON.stringify({ type: "event", event: "srtla.stats", data: ev });

function broadcastStats(ev: SrtlaStatsEvent): void {
	let msg: string | null = null;
	for (const sink of sinks) {
		const interval = sink.statsIntervalMs ?? 0;
		if (interval < 0 || !sink.active()) continue;
		// A stop (`stats: null`) always goes out so viewers do not keep stale numbers
		if (ev.stats && interval > 0 && ev.at - (lastStatsSent.get(sink) ?? 0) < interval - STATS_JITTER_MS) continue;
		lastStatsSent.set(sink, ev.at);
		msg ??= statsEvent(ev);
		sink.send(msg);
	}
}

/** Register a status push target; returns an unregister function. */
export function addStatusSink(sink: StatusSink): () => void {
	sinks.add(sink);
	if (!unsubscribeState) {
		const offState = onStateChange(scheduleBroadcast);
		const offControl = onSrtlaControlChange(scheduleBroadcast);
		const offStats = onSrtlaStats(broadcastStats);
		const offLog = onLogEntry((entry) => {
			const msg = logPayload({ entries: [entry] });
			for (const s of sinks) if (s.active()) s.send(msg);
		});
		unsubscribeState = () => {
			offState();
			offControl();
			offStats();
			offLog();
		};
	}
	return () => {
		sinks.delete(sink);
		lastStatsSent.delete(sink);
	};
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

/**
 * Create the HTTP/WS server. The routes table is fixed per server instance:
 * while `setupRequired` (no state file) "/" serves the setup wizard instead
 * of the main UI, so a state change needs restartApiServer().
 */
function createApiServer(): void {
	server = Bun.serve({
		hostname: API_HOST,
		port: API_PORT,
		// Web UI from public/ — Bun bundles the HTML's scripts and styles on the fly
		routes: setupRequired
			? { "/": setup, "/settings/": settings, "/setup/": setup }
			: { "/": index, "/settings/": settings, "/setup/": setup },
		async fetch(req, srv) {
			const path = new URL(req.url).pathname;
			if (path === "/settings") return Response.redirect("/settings/", 308);
			if (path === "/setup") return Response.redirect("/setup/", 308);
			if (IMG_PATH_RE.test(path)) {
				return await svgResponse(path);
			}
			if (path !== WS_PATH) {
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
					ws.send(logHistoryEvent());
					ws.send(await statusEvent());
					if (latestSrtlaStats().stats) ws.send(statsEvent());
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

/** Swap the running server for one whose routes reflect the current setup state. */
function restartApiServer(): void {
	server?.stop(true);
	createApiServer();
}

export function startApiServer(): void {
	createApiServer();
}
