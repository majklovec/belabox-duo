/**
 * Low-bitrate switcher — the sub-component the obs-controller module hosts:
 * resolves the configured sources, samples them, drives scene changes through
 * the module's own obs client (no second OBS websocket is opened), owns the
 * poll loop, and pushes the live status as `lowBitrateSwitcher.state` events.
 * Pure engine: switcher-engine.ts alongside.
 *
 * Config lives in state.settings.modules["obs-controller"].switcher. The obs
 * module's start/stop owns this sub-component's lifecycle (backend.ts).
 *
 * Self-contained: the only core edge is the bag; metric sources are the
 * control server's registered devices, read through server-mediated requests.
 */
import { randomUUID } from "node:crypto";
import { appendFile, mkdir } from "node:fs/promises";
import { dirname, join } from "node:path";

import { OBS_DISCONNECTED_EVENT, type ObsClient } from "../../obs-client";
import {
	defaultLowBitrateSwitcherConfig,
	SWITCHER_SOURCE_ROLES,
	type LowBitrateSwitcherConfig,
	type MCore,
	type Mctx,
	type SwitcherActiveSources,
	type SwitcherDeviceOption,
	type SwitcherMetricSources,
	type SwitcherMetrics,
	type SwitcherStatus,
} from "./types";
import { normalizeSwitcherConfig, SwitcherEngine, type ObsSnapshot } from "./switcher-engine";

const SECTION = "LowBitrateSwitcher";

/** The control server's registry, cached per start (refreshed at start + per poll). */
let deviceList: SwitcherDeviceOption[] | null = null;

/** Wire shapes returned by the metric source devices (their methods.ts). */
interface EncoderStatusResult {
	encoder?: { running: boolean };
}
interface SrtlaStatsResult {
	at?: number;
	stats?: { links: { connected: boolean; bitrate_bytes_per_sec: number; rtt_ms: number }[] } | null;
}

/** Core bag, set at bind (discovery) and re-filled at startSwitcher (a module may not import the core directly). */
let core: MCore;

/** Bind the process core before startSwitcher (called from the host module's bind). */
export function bindSwitcherCore(c: MCore): void {
	core = c;
}

/** The module's obs client, as handed in by the (hosting) backend at start. */
let getClient: (() => ObsClient | null) | null = null;

let cfg: LowBitrateSwitcherConfig = defaultLowBitrateSwitcherConfig();
let engine: SwitcherEngine | null = null;
let sources: SwitcherActiveSources = { encoder: null, relay: null };
let scene: string | null = null;
let streaming = false;
let fileLogBroken = false;

/** The persisted config slice (loaded at start, from the core bag's state). */
export function loadSwitcherConfig(): LowBitrateSwitcherConfig {
	const stored = core.state.settings.modules?.["obs-controller"]?.switcher;
	return normalizeSwitcherConfig(stored) ?? defaultLowBitrateSwitcherConfig();
}

const fileLog = (): string => join(dirname(core.config.LOG_FILE), "lowBitrateSwitcher.log");

/** The obs client of the hosting module (null: not started / not running). */
function obsClient(): ObsClient | null {
	if (cfg.obsController.moduleId !== "obs-controller") return null;
	return getClient?.() ?? null;
}

function obsSnapshot(): ObsSnapshot | null {
	const client = obsClient();
	if (!client) return null;
	return {
		connected: client.connected && client.identified,
		streaming,
		scene,
	};
}

async function obsSetScene(name: string): Promise<boolean> {
	const client = obsClient();
	if (!client) return false;
	try {
		const res = await client.sendRequest({
			requestType: "SetCurrentProgramScene",
			requestId: randomUUID(),
			requestData: { SceneName: name },
		});
		return res.requestStatus.result;
	} catch {
		return false;
	}
}

/** Warm the scene / streaming tracking from OBS itself. */
async function obsWarmStart(client: ObsClient): Promise<void> {
	try {
		const [sc, st] = await Promise.all([
			client.sendRequest({ requestType: "GetCurrentProgramScene", requestId: randomUUID(), requestData: {} }),
			client.sendRequest({ requestType: "GetStreamStatus", requestId: randomUUID(), requestData: {} }),
		]);
		if (typeof sc.responseData?.["CurrentProgramSceneName"] === "string") {
			scene = sc.responseData["CurrentProgramSceneName"] as string;
		}
		if (typeof st.responseData?.["OutputState"] === "number") {
			streaming = (st.responseData["OutputState"] as number) === 1;
		}
	} catch {
		// Identification is in flight; the event handlers pick it up
	}
}

let attachedTo: ObsClient | null = null;

/** Attach to the hosting obs client's scene / streaming events (no new connection). */
function attachObsEvents(): void {
	const client = obsClient();
	if (!client) return;
	if (attachedTo === client) {
		void obsWarmStart(client);
		return;
	}
	attachedTo = client;
	client.on("CurrentProgramSceneChanged", (d: Record<string, unknown>) => {
		scene = typeof d["CurrentProgramSceneName"] === "string" ? (d["CurrentProgramSceneName"] as string) : scene;
	});
	client.on("StreamStateChanged", (d: Record<string, unknown>) => {
		if (typeof d["OutputState"] === "number") streaming = (d["OutputState"] as number) === 1;
	});
	client.on(OBS_DISCONNECTED_EVENT, () => {
		// The obs module owns reconnects; we just track the drop
	});
	void obsWarmStart(client);
}

// ---------------------------------------------------------------------- sources

/** Merge one source's contribution; a null field must not clobber a value. */
function mergeField<T>(cur: T | null, next: T | null): T | null {
	return next === null ? cur : next;
}

/** Refresh the control server's registry, best-effort (null when no remote link). */
async function refreshDeviceList(): Promise<void> {
	try {
		deviceList = await core.listDevices();
	} catch {
		deviceList = null;
	}
}

/** Ask a source device for its srtla link stats (null when it answers none). */
async function requestLinks(deviceId: string): Promise<{ connected: boolean; bitrate_bytes_per_sec: number; rtt_ms: number }[] | null> {
	try {
		const res = (await core.requestDevice(deviceId, "srtla.stats")) as SrtlaStatsResult;
		return res.stats?.links ?? null;
	} catch {
		// Source unreachable this poll; the engine sees a metrics gap
		return null;
	}
}

/**
 * Resolve the enabled sources into the device ids that will feed the engine.
 * A slot is active only when its configured device is registered, online, and
 * its role matches the slot's (encoder slot: encoder/combined devices; relay
 * slot: relay/combined ones).
 */
function resolveSources(): SwitcherActiveSources {
	const out: SwitcherActiveSources = { encoder: null, relay: null };
	for (const key of ["encoder", "relay"] as const) {
		const s = cfg.sources[key];
		if (!s.enabled) continue;
		const device = deviceList?.find((d) => d.id === s.deviceId);
		if (!device) {
			core.logEvent("warn", SECTION, `${key} source device "${s.deviceId}" is not registered; source skipped`);
			continue;
		}
		if (!device.online) {
			core.logEvent("warn", SECTION, `${key} source device "${device.hostname ?? s.deviceId}" is offline; source skipped`);
			continue;
		}
		if (!SWITCHER_SOURCE_ROLES[key].includes(device.role ?? "")) {
			core.logEvent("warn", SECTION, `${key} source device "${device.hostname ?? s.deviceId}" has a non-matching role (${device.role}); source skipped`);
			continue;
		}
		out[key] = device.id;
	}
	if (!out.encoder && !out.relay) {
		core.logEvent("warn", SECTION, "no active source is configured; switcher idle");
	}
	return out;
}

/** One merged sample of the resolved sources; null when none is available. */
async function collectMetrics(): Promise<SwitcherMetrics | null> {
	await refreshDeviceList();
	const acc = {
		any: false,
		connected: null as boolean | null,
		bitrateKbps: null as number | null,
		rttMs: null as number | null,
		streaming: null as boolean | null,
	};
	const applyLinks = (links: { connected: boolean; bitrate_bytes_per_sec: number; rtt_ms: number }[]): void => {
		const live = links.filter((l) => l.connected);
		acc.connected = mergeField(acc.connected, live.length > 0);
		acc.bitrateKbps = mergeField(acc.bitrateKbps, Math.round((live.reduce((a, l) => a + l.bitrate_bytes_per_sec, 0) * 8 * 1000) / 1e6 * 10) / 10);
		acc.rttMs = mergeField(acc.rttMs, live.length > 0 ? Math.max(...live.map((l) => l.rtt_ms)) : null);
	};
	if (sources.encoder) {
		try {
			const res = (await core.requestDevice(sources.encoder, "encoder.status")) as EncoderStatusResult;
			const running = res.encoder?.running;
			if (typeof running === "boolean") {
				acc.any = true;
				acc.connected = mergeField(acc.connected, running);
				acc.streaming = mergeField(acc.streaming, running);
			}
		} catch {
			// Source unreachable this poll; the engine sees a metrics gap
		}
		// A combined device runs the wire too — its stats carry the bitrate/rtt.
		if (deviceList?.find((d) => d.id === sources.encoder)?.role === "combined") {
			const links = await requestLinks(sources.encoder);
			if (links) applyLinks(links);
		}
	}
	if (sources.relay) {
		const links = await requestLinks(sources.relay);
		if (links) {
			acc.any = true;
			applyLinks(links);
		}
	}
	if (!acc.any) return null;
	return { bitrateKbps: acc.bitrateKbps, rttMs: acc.rttMs, connected: acc.connected, streaming: acc.streaming };
}

// ------------------------------------------------------------------------ logging

function moduleLog(level: "info" | "warn" | "error", message: string): void {
	core.logEvent(level, SECTION, message);
	if (cfg.logToFile && !fileLogBroken) {
		const line = `${JSON.stringify({ at: Date.now(), level, message })}\n`;
		const path = fileLog();
		mkdir(dirname(path), { recursive: true })
			.then(() => appendFile(path, line))
			.catch(() => {
				fileLogBroken = true;
			});
	}
}

// ------------------------------------------------------------------------ services

/**
 * The switcher services consumed by the hosting obs module (backend.ts) —
 * the module stays the only door to its sub-component.
 */
export const switcherServices = {
	/** Apply a modules.configure switcher slice (the caller saves); 400 on invalid input. */
	configure(config: Record<string, unknown>): void {
		const next = normalizeSwitcherConfig(config);
		if (!next) throw new core.ApiError("invalid switcher config", 400);
		const obs = core.state.settings.modules?.["obs-controller"];
		if (!obs) return;
		cfg = next;
		obs.switcher = next;
	},
	/** Live status fragment for buildStatus(). */
	status(): SwitcherStatus | null {
		return engine?.status() ?? null;
	},
	/**
	 * The metric source options (part of the module configuration surface):
	 * the registered devices each source slot can read from — the encoder slot
	 * lists encoder/combined devices, the relay slot relay/combined ones.
	 * Empty until the first registry query succeeds.
	 */
	metricSources(): SwitcherMetricSources {
		const list = deviceList ?? [];
		return {
			encoder: list.filter((d) => SWITCHER_SOURCE_ROLES.encoder.includes(d.role ?? "")),
			relay: list.filter((d) => SWITCHER_SOURCE_ROLES.relay.includes(d.role ?? "")),
		};
	},
};

/**
 * Start the sub-component (called from the obs module's start when the OBS-level
 * `switcherEnabled` parameter is on): resolves the sources, attaches to the obs
 * client's events, starts the poll loop.
 */
export async function startSwitcher(ctx: Mctx, getClientAccessor: () => ObsClient | null): Promise<void> {
	bindSwitcherCore(ctx.core);
	getClient = getClientAccessor;
	attachedTo = null; // the obs client is fresh on every module start
	deviceList = null;
	cfg = loadSwitcherConfig();
	await refreshDeviceList();
	sources = resolveSources();
	attachObsEvents();
	engine = new SwitcherEngine(cfg, {
		obs: obsSnapshot,
		setScene: obsSetScene,
		metrics: collectMetrics,
		sources: () => sources,
		log: moduleLog,
		onUpdate: () => ctx.emit("lowBitrateSwitcher.state", switcherServices.status() ?? {}),
		now: () => Date.now(),
	});
	engine.start();
	moduleLog("info", `started (sources: ${[sources.encoder, sources.relay].filter(Boolean).join(", ") || "none"})`);
}

/** Stop the sub-component (called from the obs module's stop). */
export function stopSwitcher(): void {
	engine?.stop();
	engine = null;
	getClient = null;
	deviceList = null;
}
