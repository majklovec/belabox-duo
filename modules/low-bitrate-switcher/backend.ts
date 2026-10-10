/**
 * Low-bitrate switcher — a module of its own: resolves the configured metric
 * sources (registered devices of matching roles), samples them, drives scene
 * changes through a capability reference to the obs-controller module's
 * client (no second OBS websocket is opened), owns the poll loop, and pushes
 * the live status as `lowBitrateSwitcher.state` events. Pure engine:
 * switcher-engine.ts alongside.
 *
 * Config: the module's own persisted slice — the same shape as
 * `SwitcherConfig` plus `enabled`. Applied field by field with the previous
 * value as fallback; the frontend form carries the defaults (there is no
 * core-side factory or normalizer).
 *
 * Self-contained: the only core edge is the bag; metric sources are the
 * control server's registered devices, read through server-mediated requests.
 */
import { randomUUID } from "node:crypto";
import { appendFile, mkdir } from "node:fs/promises";
import { dirname, join } from "node:path";
import { z } from "zod";

import { OBS_DISCONNECTED_EVENT } from "../../obs-client";
import type {
	SwitcherActiveSources,
	SwitcherConfig,
	SwitcherDeviceOption,
	SwitcherMetricSources,
	SwitcherMetrics,
	SwitcherSourceConfig,
} from "../../public/types";
import { SwitcherEngine, type ObsSnapshot } from "./switcher-engine";
import {
	SWITCHER_SOURCE_ROLES,
	type MCore,
	type Mctx,
	type ObsServices,
} from "./types";

const SECTION = "LowBitrateSwitcher";
const MODULE_ID = "low-bitrate-switcher";

/** The slice persisted under settings.modules["low-bitrate-switcher"]. */
type SliceConfig = SwitcherConfig & { enabled: boolean };

/** The obs client as this module sees it (structural). */
type ObsClient = NonNullable<ReturnType<ObsServices["client"]>>;

/** Wire shapes returned by the metric source devices (their methods.ts). */
interface EncoderStatusResult {
	encoder?: { running: boolean };
}
interface SrtlaStatsResult {
	at?: number;
	stats?: { links: { connected: boolean; bitrate_bytes_per_sec: number; rtt_ms: number }[] } | null;
}

let core: MCore;
/** The control server's registry, cached per start (refreshed at start + per poll). */
let deviceList: SwitcherDeviceOption[] | null = null;
let cfg: SliceConfig;
let engine: SwitcherEngine | null = null;
let sources: SwitcherActiveSources = { encoder: null, relay: null };
let scene: string | null = null;
let streaming = false;
let attachedTo: ObsClient | null = null;
let fileLogBroken = false;

const fileLog = (): string => join(dirname(core.config.LOG_FILE), "lowBitrateSwitcher.log");

/** The module's own persisted slice (the registry hands it over via ctx.config). */
function moduleSlice(): SliceConfig {
	const stored = core.state.settings.modules?.[MODULE_ID] as Record<string, unknown> | undefined;
	return stored as unknown as SliceConfig;
}

/**
 * Apply a raw config slice (the `lowBitrateSwitcher.save` body) over the
 * current config: a field keeps the previous value when the sent one is not
 * of the expected shape. The form is the source of the defaults.
 */
function applyConfig(raw: Record<string, unknown>): SliceConfig {
	const out: SliceConfig = structuredClone(cfg);
	const src = (inKey: "encoder" | "relay", v: unknown): SwitcherSourceConfig => {
		const o = v && typeof v === "object" ? (v as Record<string, unknown>) : {};
		return {
			enabled: o["enabled"] === true,
			deviceId: typeof o["deviceId"] === "string" ? o["deviceId"] : out.sources[inKey].deviceId,
		};
	};
	if (raw["sources"] && typeof raw["sources"] === "object") {
		const s = raw["sources"] as Record<string, unknown>;
		if (s["encoder"] !== undefined) out.sources.encoder = src("encoder", s["encoder"]);
		if (s["relay"] !== undefined) out.sources.relay = src("relay", s["relay"]);
	}
	const str = (v: unknown, fallback: string): string => (typeof v === "string" ? v : fallback);
	if (raw["failBehaviour"] === "pause" || raw["failBehaviour"] === "ignore") out.failBehaviour = raw["failBehaviour"];
	out.autoSwitch = raw["autoSwitch"] === true ? true : raw["autoSwitch"] === false ? false : out.autoSwitch;
	for (const key of ["onlySwitchWhenStreaming", "instantlySwitchOnRecover", "logToFile"] as const) {
		if (raw[key] === true) out[key] = true;
		else if (raw[key] === false) out[key] = false;
	}
	if (typeof raw["retryAttempts"] === "number" && Number.isInteger(raw["retryAttempts"]) && raw["retryAttempts"] >= 1 && raw["retryAttempts"] <= 100) {
		out.retryAttempts = raw["retryAttempts"];
	}
	if (typeof raw["pollIntervalMs"] === "number" && Number.isInteger(raw["pollIntervalMs"]) && raw["pollIntervalMs"] >= 200 && raw["pollIntervalMs"] <= 3_600_000) {
		out.pollIntervalMs = raw["pollIntervalMs"];
	}
	if (raw["triggers"] && typeof raw["triggers"] === "object") {
		const t = raw["triggers"] as Record<string, unknown>;
		for (const key of ["low", "offline", "rtt"] as const) {
			if (typeof t[key] === "number" && Number.isFinite(t[key]) && t[key] >= 0) out.triggers[key] = t[key];
		}
	}
	for (const key of ["normal", "low", "offline"] as const) {
		if (raw["scenes"] && typeof raw["scenes"] === "object" && typeof (raw["scenes"] as Record<string, unknown>)[key] === "string") {
			out.scenes[key] = (raw["scenes"] as Record<string, unknown>)[key] as string;
		}
	}
	for (const key of ["starting", "ending", "privacy"] as const) {
		if (raw["optionalScenes"] && typeof raw["optionalScenes"] === "object" && typeof (raw["optionalScenes"] as Record<string, unknown>)[key] === "string") {
			out.optionalScenes[key] = (raw["optionalScenes"] as Record<string, unknown>)[key] as string;
		}
	}
	return out;
}

// ---------------------------------------------------------------------- obs edge

/** The obs-controller's live client via the capability bus (null: module down). */
function obsClient(): ObsClient | null {
	try {
		return core.requireCapability<ObsServices>("obs.controller").client();
	} catch {
		return null;
	}
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

/**
 * Attach to the obs module's scene / streaming events (no new connection).
 * Re-checked on every poll: the obs module hands out a fresh client on each
 * start, and a stale listener set would freeze the scene tracking.
 */
function attachObsEvents(): void {
	const client = obsClient();
	if (!client) return;
	if (attachedTo === client) return;
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

// ------------------------------------------------------------------------ engine

async function startEngine(): Promise<void> {
	cfg = moduleSlice();
	await refreshDeviceList();
	sources = resolveSources();
	engine = new SwitcherEngine(cfg, {
		obs: obsSnapshot,
		setScene: obsSetScene,
		metrics: collectMetrics,
		sources: () => sources,
		log: moduleLog,
		onUpdate: () => push(),
		now: () => Date.now(),
	});
	engine.start();
	moduleLog("info", `started (sources: ${[sources.encoder, sources.relay].filter(Boolean).join(", ") || "none"})`);
}

function stopEngine(): void {
	engine?.stop();
	engine = null;
	attachedTo = null; // the obs client is fresh on every obs module start
	deviceList = null;
}

/** Push the live status (the registry tags it with the module id). */
let emit: (event: string, data: unknown) => void = () => {};
function push(): void {
	emit("lowBitrateSwitcher.state", engine?.status() ?? null);
}

/** The metric source options: the registered devices each slot can read from. */
function metricSources(): SwitcherMetricSources {
	const list = deviceList ?? [];
	return {
		encoder: list.filter((d) => SWITCHER_SOURCE_ROLES.encoder.includes(d.role ?? "")),
		relay: list.filter((d) => SWITCHER_SOURCE_ROLES.relay.includes(d.role ?? "")),
	};
}

// ------------------------------------------------------------------------ module

export default {
	kind: "device",
	id: MODULE_ID,
	title: "Low bitrate switcher",
	dependencies: ["obs-controller"],
	configSchema: z.object({
		enabled: z.boolean(),
		sources: z.record(z.string(), z.unknown()),
		failBehaviour: z.string(),
		autoSwitch: z.boolean(),
		onlySwitchWhenStreaming: z.boolean(),
		instantlySwitchOnRecover: z.boolean(),
		retryAttempts: z.number(),
		pollIntervalMs: z.number(),
		triggers: z.record(z.string(), z.unknown()),
		scenes: z.record(z.string(), z.unknown()),
		optionalScenes: z.record(z.string(), z.unknown()),
		logToFile: z.boolean(),
	}),
	bind(c: MCore) {
		core = c;
	},
	async start(ctx: Mctx) {
		core = ctx.core;
		emit = ctx.emit;
		if (ctx.config.enabled !== true) return;
		await stopEngine();
		await startEngine();
	},
	async stop() {
		stopEngine();
	},
	methods: ["lowBitrateSwitcher.save"] as const,
	events: ["lowBitrateSwitcher.state"] as const,
	status(): Record<string, unknown> {
		return {
			// Live state (null = not running) + the metric source options
			// (the configuration surface that feeds the UI selects)
			lowBitrateSwitcher: engine?.status() ?? null,
			switcherMetricSources: metricSources(),
		};
	},
	async dispatch(method: string, params: Record<string, unknown>): Promise<unknown> {
		switch (method) {
			case "lowBitrateSwitcher.save": {
				// The form sends the full flat slice; a field that does not match
				// its shape keeps the previous value.
				const body =
					params["config"] && typeof params["config"] === "object" && !Array.isArray(params["config"])
						? (params["config"] as Record<string, unknown>)
						: params;
				const next = applyConfig(body);
				const slice = (core.state.settings.modules ??= {})[MODULE_ID] ?? {};
				Object.assign(slice, next);
				core.state.settings.modules![MODULE_ID] = slice;
				await core.saveState();
				// Hot-apply: the running engine picks the new values up right away
				if (engine) {
					cfg = next;
					await refreshDeviceList();
					sources = resolveSources();
					engine.updateConfig(cfg);
					engine.start();
				}
				return { ok: true };
			}
			default:
				throw new core.ApiError(`Unknown method: ${method}`, 404);
		}
	},
};
