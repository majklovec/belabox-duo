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
 * Self-contained: inter-module access flows through the capability bus
 * (capability names, never module ids); the only core edge is the bag.
 */
import { randomUUID } from "node:crypto";
import { appendFile, mkdir } from "node:fs/promises";
import { dirname, join } from "node:path";

import { OBS_DISCONNECTED_EVENT, type ObsClient } from "../../obs-client";
import {
	defaultLowBitrateSwitcherConfig,
	type LowBitrateSwitcherConfig,
	type MCore,
	type Mctx,
	type SwitcherActiveSources,
	type SwitcherMetrics,
	type SwitcherStatus,
} from "./types";
import { normalizeSwitcherConfig, SwitcherEngine, type ObsSnapshot } from "./switcher-engine";

const SECTION = "LowBitrateSwitcher";

/** Capability shapes the switcher reads through the bus (minimally typed). */
interface EncoderCap {
	encoder(): { status(): { running: boolean } };
}
interface SrtlaCap {
	latestStats(): {
		at: number;
		stats?: {
			links: { connected: boolean; bitrate_bytes_per_sec: number; rtt_ms: number }[];
		} | null;
	};
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
let sources: SwitcherActiveSources = { encoder: null, relay: null, combined: null };
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

/** `relay` is the persisted id for the srtla module; accept both. */
const relayModuleId = (id: string): string => (id === "relay" ? "srtla" : id);

/** Resolve the enabled sources into the module ids that will feed the engine. */
function resolveSources(): SwitcherActiveSources {
	const out: SwitcherActiveSources = { encoder: null, relay: null, combined: null };
	const combinedCfg = cfg.sources.combined;
	if (combinedCfg.enabled) {
		if (core.moduleById(combinedCfg.moduleId)) {
			out.combined = combinedCfg.moduleId;
			return out; // combined takes precedence over the individual sources
		}
		core.logEvent("warn", SECTION, `combined source module "${combinedCfg.moduleId}" not found; falling back to encoder/relay`);
	}
	if (cfg.sources.encoder.enabled) {
		if (core.moduleById(cfg.sources.encoder.moduleId)) out.encoder = cfg.sources.encoder.moduleId;
		else core.logEvent("warn", SECTION, `encoder source module "${cfg.sources.encoder.moduleId}" not found; source skipped`);
	}
	if (cfg.sources.relay.enabled) {
		const id = relayModuleId(cfg.sources.relay.moduleId);
		if (core.moduleById(id)) out.relay = cfg.sources.relay.moduleId;
		else core.logEvent("warn", SECTION, `relay source module "${cfg.sources.relay.moduleId}" not found; source skipped`);
	}
	if (!out.encoder && !out.relay && !out.combined) {
		core.logEvent("warn", SECTION, "no active source is configured; switcher idle");
	}
	return out;
}

/** Merge one source's contribution; a null field must not clobber a value. */
function mergeField<T>(cur: T | null, next: T | null): T | null {
	return next === null ? cur : next;
}

/** One merged sample of the resolved sources; null when none is available. */
async function collectMetrics(): Promise<SwitcherMetrics | null> {
	if (sources.combined) {
		const mod = core.moduleById(sources.combined);
		if (!mod?.status) return null;
		const frag = (await mod.status()) as Record<string, Record<string, unknown>>;
		const rec = frag[sources.combined] ?? frag[Object.keys(frag)[0]] ?? {};
		const fm = cfg.sources.combined.fieldMap;
		const num = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) ? v : null);
		const bool = (v: unknown): boolean | null => (typeof v === "boolean" ? v : null);
		return {
			bitrateKbps: num(rec[fm.bitrate]),
			rttMs: num(rec[fm.rtt]),
			connected: bool(rec[fm.connected]),
			streaming: bool(rec[fm.streaming]),
		};
	}

	let any = false;
	let connected: boolean | null = null;
	let bitrateKbps: number | null = null;
	let rttMs: number | null = null;
	let streamingField: boolean | null = null;

	if (sources.encoder) {
		const enc = core.requireCapability<EncoderCap>("stream.encoder").encoder().status();
		any = true;
		connected = mergeField(connected, enc.running);
		streamingField = mergeField(streamingField, enc.running);
		// belacoder exposes no live bitrate; its triggers are skipped
	}
	if (sources.relay) {
		const stat = core.requireCapability<SrtlaCap>("stream.srtla").latestStats().stats ?? null;
		if (stat) {
			any = true;
			const links = stat.links.filter((l) => l.connected);
			connected = mergeField(connected, links.length > 0);
			bitrateKbps = mergeField(bitrateKbps, Math.round((links.reduce((a, l) => a + l.bitrate_bytes_per_sec, 0) * 8 * 1000) / 1e6 * 10) / 10);
			rttMs = mergeField(rttMs, links.length > 0 ? Math.max(...links.map((l) => l.rtt_ms)) : null);
		}
	}
	if (!any) return null;
	return { bitrateKbps, rttMs, connected, streaming: streamingField };
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
};

/**
 * Start the sub-component (called from the obs module's start when the OBS-level
 * `switcherEnabled` parameter is on): resolves the sources, attaches to the obs
 * client's events, starts the poll loop.
 */
export function startSwitcher(ctx: Mctx, getClientAccessor: () => ObsClient | null): void {
	bindSwitcherCore(ctx.core);
	getClient = getClientAccessor;
	attachedTo = null; // the obs client is fresh on every module start
	cfg = loadSwitcherConfig();
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
	moduleLog("info", `started (sources: ${[sources.encoder, sources.relay, sources.combined].filter(Boolean).join(", ") || "none"})`);
}

/** Stop the sub-component (called from the obs module's stop). */
export function stopSwitcher(): void {
	engine?.stop();
	engine = null;
	getClient = null;
}
