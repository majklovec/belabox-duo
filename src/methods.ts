/*
 * WebSocket API methods and request dispatch. Transport-agnostic: the local server
 * (api.ts) and the remote control link (remote.ts) both pass raw frames to handleRequest().
 *
 * Client → server (request):
 *   { "id": 1, "method": "modems.toggle", "params": { "iface": "wwan0" } }
 *
 * Server → client (response to a request, `id` echoed back):
 *   { "type": "response", "id": 1, "method": "modems.toggle", "ok": true,  "result": { ... } }
 *   { "type": "response", "id": 1, "method": "modems.toggle", "ok": false, "error": "...", "code": 404 }
 *
 * Server → client (push, sent on connect and whenever state changes; see push.ts):
 *   { "type": "event", "event": "status", "data": { ...same as `status` result... } }
 *   { "type": "event", "event": "log", "data": { "reset"?: true, "entries": [LogEntry, ...] } }
 *     (full history with `reset` on connect, then each new or updated entry; see logMessages.ts)
 *   { "type": "event", "event": "srtla.stats", "data": { "at": <ms>, "stats": {...} | null } }
 *     (~1 Hz while srtla_send runs with a control socket; `null` when it stops)
 *
 * Methods:
 *   status, interfaces.list, reconfigure, log.list
 *   setup.get, setup.complete {...wizard answers}   (only while the device has no config file)
 *   settings.get, settings.update {hostname?, role?, color?, remoteUrl?, remoteToken?, language?}
 *   modems.list, modems.select {modems?|ips?}, modems.toggle {iface}
 *   modems.enable|disable|reset|connect|disconnect {index}
 *   srtla.status, srtla.start {listenPort, remoteHost, remotePort}, srtla.stop, srtla.reload
 *   srtla.stats   latest per-link telemetry from srtla_send's control socket
 *   srtla.options {mode? ("classic"|"enhanced"), quality? (bool)}   applied live when possible
 *   pipelines.list
 *   pipelines.repositories.add {repository}, pipelines.repositories.remove {repository}
 *   pipelines.repositories.updateAll
 *   encoder.status, encoder.start {pipeline, host, port, minBitrate?, maxBitrate?, latency?, delay?,
 *                                  streamid?, audioSource?, audioCodec? ("aac"|"opus"), bitrateOverlay?},
 *   encoder.stop, encoder.bitrate {maxBitrate?, minBitrate?}   (at least one; applied live)
 *   ceracoder.set {balancer? ("adaptive"|"fixed"|"aimd"), adaptive? {incrStep?,
 *                   decrStep?, incrInterval?, decrInterval?}, aimd? {incrStep?, decrMult?,
 *                   incrInterval?, decrInterval?}}   (ceracoder encoder only; applied live)
 *   stream.start {pipeline, remoteHost, remotePort, listenPort?, ...same encoder options},
 *   stream.stop   (combined devices: srtla_send + belacoder in one action)
 *   autostart.set {enabled}   resume the last stream when the service starts
 *
 * Methods are limited by the device role (--role): relay → modems/srtla/reconfigure,
 * encoder → pipelines/encoder, combined → everything plus stream.*.
 * Methods that change something are recorded in the event log (success or failure); their
 * responses carry `"logged": true` so clients do not log them a second time.
 */
import { randomUUID } from "node:crypto";
import { Ceracoder } from "./ceracoder";
import { PIPELINES_DIR, RELOAD_MODE, ROLE, UPLINKS_FILE } from "./config";
import { AUDIO_CODECS, AUDIO_DEFAULT, type EncoderConfig, encoder, listAudioSources, listPipelines } from "./encoder";
import { logEntries, logEvent } from "./eventlog";
import { LANGUAGES, setCurrentLanguage, t } from "./i18n";
import { isLoggedMethod, methodLog } from "./logMessages";
import { connectModem, detectModems, disconnectModem, resetModem, setModemEnabled } from "./modems";
import {
	ApiError,
	checkColor,
	checkHostname,
	checkRemoteUrl,
	oneOf,
	optionalInt,
	optionalSettingString,
	optionalStringList,
	type Params,
	requireBoolean,
	requireHost,
	requireModemIndex,
	requirePort,
	requireString,
} from "./params";
import { removePipelineRepository, syncPipelineRepository } from "./pipelineRepos";
import { applyRemoteSettings } from "./remote";
import { detectInterfaces, isMonitorRunning, type ModemConfig, reconfigure, resolveSelection, setSelection } from "./routing";
import { reloadSrtla, setSrtlaOptions, srtlaStatus, startSrtla, stopSrtla } from "./srtla";
import { latestSrtlaStats, SRTLA_MODES, srtlaControlState } from "./srtlaControl";
import { completeSetup, type SrtlaOptions, saveState, setupRequired, type SrtlaTarget, state, uiLanguage } from "./state";
import { cancelAutostart, setAutostart, startCombined, stopCombined } from "./stream";
import { errorMessage, scrubUrl, textOf } from "./util";
import { BITRATE_KBPS, DEFAULT_COLOR, type Role, ROLES } from "./validate";

type Method = (params: Params) => Promise<object> | object;

/**
 * The role the device is configured with — the role saved in the UI wins over
 * the role the process started with, so the UI reflects the saved
 * configuration immediately. Subprocess wiring (autostart, bonding monitor)
 * follows the process role and applies on the next service restart.
 */
const effectiveRole = (): Role => state.settings.role ?? ROLE;

export async function buildStatus() {
	const role = effectiveRole();
	const enc = encoder();
	// One ModemManager scan serves both the interface enrichment and the modem list
	const modems = await detectModems();
	const [interfaces, audioSources] = await Promise.all([
		detectInterfaces(modems),
		role !== "relay" ? listAudioSources() : [],
	]);
	return {
		role,
		setupRequired,
		state: {
			selection: state.selection,
			srtla: srtlaStatus(),
			encoder: enc.status(),
			stream: state.stream,
			srtlaTarget: state.srtlaTarget,
			srtlaOptions: state.srtlaOptions ?? {},
			autostart: !!state.autostart,
		},
		interfaces,
		// Encoder-only devices do no bonding and have no modems to manage
		selected: role !== "encoder" ? resolveSelection(interfaces) : [],
		modems: role !== "encoder" ? modems : [],
		audioSources,
		uplinksFile: UPLINKS_FILE,
		srtlaControl: srtlaControlState(),
		monitor: { running: isMonitorRunning(), reloadMode: RELOAD_MODE },
		// null when the encoder binary is not ceracoder; the UI hides its settings then
		ceracoder: enc instanceof Ceracoder ? enc.config() : null,
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
	const { selected, ips, uplinksFile, changed } = await reconfigureAndReload();
	return { selection: state.selection, selected, ips, uplinksFile, changed };
}

// ----------------------------------------------------------------------
// Encoder
// ----------------------------------------------------------------------
/** Min / max bitrate (kbps), defaulting to the last used values; `minFirst` sets which is validated first. */
function parseBitrates(p: Params, minFirst = false): { minBitrate: number; maxBitrate: number } {
	const prev = state.encoder.config;
	const { min, max } = BITRATE_KBPS;
	const parseMax = () => optionalInt(p, "maxBitrate", prev?.maxBitrate ?? 5000, min, max);
	const parseMin = () => optionalInt(p, "minBitrate", prev?.minBitrate ?? min, min, max);
	let minBitrate: number, maxBitrate: number;
	if (minFirst) {
		minBitrate = parseMin();
		maxBitrate = parseMax();
	} else {
		maxBitrate = parseMax();
		minBitrate = parseMin();
	}
	if (minBitrate > maxBitrate) throw new ApiError("minBitrate must not exceed maxBitrate");
	return { minBitrate, maxBitrate };
}

function parseEncoderConfig(p: Params, host: string, port: string): EncoderConfig {
	const prev = state.encoder.config;
	const streamid = p.streamid === undefined || p.streamid === "" ? undefined : requireString(p, "streamid");
	const audioSource = p.audioSource === undefined || p.audioSource === ""
		? prev?.audioSource ?? AUDIO_DEFAULT
		: requireString(p, "audioSource");
	const audioCodec = oneOf(p.audioCodec ?? prev?.audioCodec ?? "aac", "audioCodec", AUDIO_CODECS);
	if (p.bitrateOverlay !== undefined) requireBoolean(p, "bitrateOverlay");
	const { minBitrate, maxBitrate } = parseBitrates(p);
	return {
		pipeline: requireString(p, "pipeline"),
		host,
		port,
		minBitrate,
		maxBitrate,
		latency: optionalInt(p, "latency", prev?.latency ?? 2000, 100, 10_000),
		delay: optionalInt(p, "delay", prev?.delay ?? 0, -2000, 2000),
		streamid,
		audioSource,
		audioCodec,
		bitrateOverlay: (p.bitrateOverlay as boolean | undefined) ?? prev?.bitrateOverlay ?? false,
	};
}

/** Map a start failure to a status code: conflicts 409, bad pipeline / audio 400, else 500. */
async function startChecked<T>(start: () => Promise<T>): Promise<T> {
	try {
		return await start();
	} catch (e: unknown) {
		const msg = errorMessage(e);
		throw new ApiError(msg, /already/.test(msg) ? 409 : /pipeline|audio/i.test(msg) ? 400 : 500);
	}
}

/** Combined devices: bring up srtla_send, then point belacoder at it. */
async function startStream(p: Params) {
	const remoteHost = requireHost(p, "remoteHost");
	const remotePort = requirePort(p, "remotePort");
	const listenPort = String(optionalInt(p, "listenPort", Number(state.stream?.listenPort ?? 9000), 1, 65535));
	const cfg = parseEncoderConfig(p, "127.0.0.1", listenPort);
	cancelAutostart();
	await startChecked(() => startCombined({ remoteHost, remotePort, listenPort }, cfg));
	return { srtla: srtlaStatus(), encoder: encoder().status() };
}

// ----------------------------------------------------------------------
// Setup and settings
// ----------------------------------------------------------------------
const settingsView = () => {
	const s = state.settings;
	return {
		uuid: s.uuid ?? "",
		hostname: s.hostname ?? "",
		role: s.role ?? "",
		remoteUrl: s.remoteUrl ?? "",
		hasRemoteToken: !!s.remoteToken,
		color: s.color ?? DEFAULT_COLOR,
		pipelineRepositories: s.pipelineRepositories ?? [],
		language: uiLanguage(),
	};
};

/** First-run wizard: validate all fields, write the initial state and bring the role up. */
async function setupComplete(p: Params): Promise<object> {
	if (!setupRequired) throw new ApiError("Setup has already been completed", 409);
	const language = p.language === undefined ? "en" : oneOf(p.language, "language", LANGUAGES);
	const role = oneOf(requireString(p, "role"), "role", ROLES);
	const hostname = checkHostname(requireString(p, "hostname").trim());
	const color = checkColor(requireString(p, "color"));
	const remoteUrl = checkRemoteUrl(optionalSettingString(p, "remoteUrl", undefined));
	const remoteToken = optionalSettingString(p, "remoteToken", undefined);

	let relayTarget: SrtlaTarget | undefined;
	let srtlaOptions: SrtlaOptions | undefined;
	if (role !== "encoder") {
		relayTarget = {
			listenPort: requirePort(p, "listenPort"),
			remoteHost: requireHost(p, "srtlaRemoteHost"),
			remotePort: requirePort(p, "srtlaRemotePort"),
		};
		srtlaOptions = {
			mode: oneOf(requireString(p, "srtlaMode"), "srtlaMode", SRTLA_MODES),
			quality: requireBoolean(p, "srtlaQuality"),
		};
	}
	let encoderConfig: EncoderConfig | undefined;
	if (role === "combined") {
		// Combined devices stream into their own srtla_send
		encoderConfig = parseEncoderConfig(p, "127.0.0.1", relayTarget!.listenPort);
	} else if (role === "encoder") {
		const port = requirePort(p, "encoderPort");
		encoderConfig = parseEncoderConfig(p, requireHost(p, "encoderHost"), port);
	}

	// Everything is valid: apply
	if (relayTarget) Object.assign(state, { srtlaTarget: relayTarget, srtlaOptions });
	if (encoderConfig) state.encoder = { running: false, config: encoderConfig };
	if (role === "combined") state.stream = relayTarget;
	state.autostart = p.autostart === true;
	// The uuid is auto-assigned from the start (state.ts) and never changes afterwards;
	// the language is always persisted so the config file carries it from day one
	state.settings = {
		...state.settings,
		uuid: state.settings.uuid ?? randomUUID(),
		hostname,
		role,
		color,
		remoteUrl,
		remoteToken,
		language,
	};
	setCurrentLanguage(language);
	await completeSetup();
	// Start (or re-target) the control-server link with the saved endpoint
	if (remoteUrl) applyRemoteSettings(remoteUrl, remoteToken);
	return { completed: true, restartRequired: true };
}

/** Partial update of the persisted settings; the device uuid is immutable. */
async function updateSettings(p: Params): Promise<object> {
	const current = state.settings;
	// The uuid is assigned at setup and immutable; the UI only ever echoes it back
	if (p.uuid !== undefined && p.uuid !== current.uuid) throw new ApiError("The device uuid can't be changed");
	const hostname = checkHostname(optionalSettingString(p, "hostname", current.hostname));
	const roleValue = optionalSettingString(p, "role", current.role);
	const role = roleValue === undefined ? undefined : oneOf(roleValue, "role", ROLES);
	const remoteUrl = checkRemoteUrl(optionalSettingString(p, "remoteUrl", current.remoteUrl));
	if (p.remoteToken !== undefined && typeof p.remoteToken !== "string") {
		throw new ApiError("remoteToken must be a string");
	}
	const remoteToken = p.remoteToken === undefined ? current.remoteToken : p.remoteToken.trim() || undefined;
	const color = checkColor(optionalSettingString(p, "color", current.color));
	const language = p.language === undefined ? uiLanguage() : oneOf(p.language, "language", LANGUAGES);
	const remoteChanged = remoteUrl !== current.remoteUrl || remoteToken !== current.remoteToken;

	state.settings = { ...current, hostname, role, remoteUrl, remoteToken, color, language };
	setCurrentLanguage(language);
	await saveState();
	// Re-dial the control-server link only when the endpoint or its token changed;
	// unrelated saves (hostname, color, language, …) keep the existing connection.
	if (remoteChanged) {
		applyRemoteSettings(remoteUrl ?? "", remoteToken);
		logEvent("info", "Settings", remoteUrl
			? t("log.settings_saved_reconnect", scrubUrl(remoteUrl))
			: t("mlog.done.remote_disabled"));
	} else {
		logEvent("info", "Settings", t("mlog.done.settings_saved"));
	}
	return { settings: settingsView(), restartRequired: true };
}

// ----------------------------------------------------------------------
// Method table
// ----------------------------------------------------------------------
const modemAction =
	(action: string, fn: (index: number) => Promise<boolean>): Method =>
	async (p) => {
		const index = requireModemIndex(p);
		return { modemIndex: index, action, ok: await fn(index) };
	};

/** Wrap a state-changing call that takes over from autostart. */
const manual =
	(fn: Method): Method =>
	(p) => {
		cancelAutostart();
		return fn(p);
	};

const methods: Record<string, Method> = {
	status: buildStatus,

	"setup.get": async () => ({
		required: setupRequired,
		hostname: state.settings.hostname ?? "",
		color: state.settings.color ?? DEFAULT_COLOR,
		language: uiLanguage(),
		pipelines: await listPipelines(),
		audioSources: await listAudioSources(),
	}),

	"setup.complete": setupComplete,

	"settings.get": () => ({ settings: settingsView(), restartRequired: true }),

	"settings.update": updateSettings,

	"interfaces.list": async () => ({ interfaces: await detectInterfaces() }),

	reconfigure: reconfigureAndReload,

	"modems.list": async () => {
		const modems = await detectModems();
		const all = await detectInterfaces(modems);
		return { selection: state.selection, selected: resolveSelection(all), modems };
	},

	"modems.select": async (p) => {
		const modems = optionalStringList(p, "modems");
		const ips = optionalStringList(p, "ips");
		const all = await detectInterfaces();
		const badIfaces = modems?.filter((m) => !all.some((i) => i.iface === m)) ?? [];
		if (badIfaces.length) throw new ApiError(`Unknown interfaces: ${badIfaces.join(", ")}`);
		const badIps = ips?.filter((ip) => !all.some((i) => i.ip === ip)) ?? [];
		if (badIps.length) throw new ApiError(`Unknown IPs: ${badIps.join(", ")}`);
		return applySelection(modems?.length ? { modems } : ips?.length ? { ips } : {});
	},

	"modems.toggle": async (p) => {
		const name = requireString(p, "iface");
		const all = await detectInterfaces();
		if (!all.some((i) => i.iface === name)) throw new ApiError(`Unknown interface: ${name}`, 404);
		const names = new Set(resolveSelection(all).map((i) => i.iface));
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

	"srtla.start": manual(async (p) => {
		const listenPort = requirePort(p, "listenPort");
		const remoteHost = requireHost(p, "remoteHost");
		const remotePort = requirePort(p, "remotePort");
		try {
			return { srtla: await startSrtla(listenPort, remoteHost, remotePort) };
		} catch (e: unknown) {
			throw new ApiError(errorMessage(e), 409);
		}
	}),

	"srtla.stop": manual(async () => {
		await stopSrtla();
		return { srtla: srtlaStatus() };
	}),

	"srtla.reload": async () => {
		await reloadSrtla();
		return { srtla: srtlaStatus() };
	},

	"srtla.stats": () => latestSrtlaStats(),

	"srtla.options": async (p) => {
		const opts: SrtlaOptions = {};
		if (p.mode !== undefined) opts.mode = oneOf(p.mode, "mode", SRTLA_MODES);
		if (p.quality !== undefined) opts.quality = requireBoolean(p, "quality");
		if (opts.mode === undefined && opts.quality === undefined) throw new ApiError("mode or quality is required");
		let result: Awaited<ReturnType<typeof setSrtlaOptions>>;
		try {
			result = await setSrtlaOptions(opts);
		} catch (e: unknown) {
			throw new ApiError(errorMessage(e), 502);
		}
		if (!result.applied && srtlaStatus().running) logEvent("warn", "SRTLA", t("log.no_control_socket"));
		return result;
	},

	"pipelines.list": async () => ({ dir: PIPELINES_DIR, pipelines: await listPipelines() }),

	"pipelines.repositories.add": async (p) => {
		const repository = requireString(p, "repository").trim();
		const result = await syncPipelineRepository(repository, PIPELINES_DIR);
		const repositories = new Set(state.settings.pipelineRepositories ?? []).add(repository);
		state.settings = { ...state.settings, pipelineRepositories: [...repositories].sort() };
		await saveState();
		return { repositories: state.settings.pipelineRepositories, result };
	},

	"pipelines.repositories.remove": async (p) => {
		const repository = requireString(p, "repository").trim();
		await removePipelineRepository(repository, PIPELINES_DIR);
		const pipelineRepositories = (state.settings.pipelineRepositories ?? []).filter((r) => r !== repository);
		state.settings = { ...state.settings, pipelineRepositories };
		await saveState();
		return { repositories: pipelineRepositories };
	},

	"pipelines.repositories.updateAll": async () => {
		const repositories = state.settings.pipelineRepositories ?? [];
		const results = [];
		for (const repository of repositories) results.push(await syncPipelineRepository(repository, PIPELINES_DIR));
		return { repositories, results };
	},

	"encoder.status": () => ({ encoder: encoder().status() }),

	"encoder.start": manual(async (p) => {
		const cfg = parseEncoderConfig(p, requireHost(p, "host"), requirePort(p, "port"));
		return { encoder: await startChecked(() => encoder().start(cfg)) };
	}),

	"encoder.stop": manual(async () => {
		await encoder().stop();
		return { encoder: encoder().status() };
	}),

	"encoder.bitrate": async (p) => {
		if (p.minBitrate === undefined && p.maxBitrate === undefined) throw new ApiError("maxBitrate or minBitrate is required");
		const { minBitrate, maxBitrate } = parseBitrates(p, true);
		return { encoder: await encoder().setBitrate(minBitrate, maxBitrate) };
	},

	"ceracoder.set": async (p) => {
		const enc = encoder();
		if (!(enc instanceof Ceracoder)) throw new ApiError("The device encoder is not ceracoder");
		try {
			return { ceracoder: await enc.update(p) };
		} catch (e: unknown) {
			throw new ApiError(errorMessage(e));
		}
	},

	"stream.start": startStream,

	"stream.stop": manual(async () => {
		await stopCombined();
		return { srtla: srtlaStatus(), encoder: encoder().status() };
	}),

	"autostart.set": async (p) => {
		await setAutostart(requireBoolean(p, "enabled"));
		return { autostart: !!state.autostart };
	},

	"log.list": () => ({ entries: logEntries() }),
};

function methodAllowed(name: string): boolean {
	const role = effectiveRole();
	if (name.startsWith("stream.")) return role === "combined";
	if (name.startsWith("encoder.") || name.startsWith("ceracoder.") || name === "pipelines.list") return role !== "relay";
	if (name.startsWith("modems.") || name.startsWith("srtla.") || name === "reconfigure") return role !== "encoder";
	return true;
}

// ----------------------------------------------------------------------
// Dispatch
// ----------------------------------------------------------------------
/** Dispatch one request message; returns the serialized response. */
export async function handleRequest(raw: string | Buffer | ArrayBuffer | Uint8Array): Promise<string> {
	let id: unknown = null;
	let method = "";
	let logged = false;
	try {
		let msg: unknown;
		try {
			msg = JSON.parse(textOf(raw));
		} catch {
			throw new ApiError("Invalid JSON");
		}
		if (!msg || typeof msg !== "object" || Array.isArray(msg)) throw new ApiError("Message must be a JSON object");
		const req = msg as { id?: unknown; method?: unknown; params?: unknown };
		id = req.id ?? null;
		if (typeof req.method !== "string") throw new ApiError("method is required");
		method = req.method;

		const handler = Object.hasOwn(methods, method) ? methods[method] : undefined;
		if (!handler) throw new ApiError(`Unknown method: ${method}`, 404);
		if (!methodAllowed(method)) throw new ApiError(`${method} is not available on ${effectiveRole()} devices`, 409);

		const params: Params =
			req.params && typeof req.params === "object" && !Array.isArray(req.params) ? (req.params as Params) : {};
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
			logEvent("error", section, t("mlog.failed", action, errorMessage(err)));
		}
		return JSON.stringify({
			type: "response", id, method, ok: false, error: errorMessage(err), code, ...(logged ? { logged } : {}),
		});
	}
}
