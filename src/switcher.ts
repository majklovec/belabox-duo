/*
 * Low-bitrate switcher config — pure, core-owned helpers.
 *
 * The switcher engine lives in the obs-controller module, but the factory
 * defaults and the config normalizer are needed by the core at state-init
 * time (state.ts backfill, methods.ts modules.configure, the obs CLI). A
 * module may not be imported here, so the pure parts live in this file; the
 * module keeps its own structural copies.
 */

/** The switcher's state machine states — each maps to a scene. */
export type SwitcherState = "NORMAL" | "LOW" | "OFFLINE";

/** The enabled flag plus which module instance a source reads from. */
export interface SwitcherSourceConfig {
	enabled: boolean;
	moduleId: string;
}

/** Maps the switcher's expected keys to the combined module's exposed keys. */
export interface SwitcherFieldMap {
	bitrate: string;
	rtt: string;
	connected: string;
	streaming: string;
}

export interface LowBitrateSwitcherSources {
	encoder: SwitcherSourceConfig;
	relay: SwitcherSourceConfig;
	combined: SwitcherSourceConfig & { fieldMap: SwitcherFieldMap };
}

/** What the switcher does when its obs-controller is disconnected. */
export type SwitcherFailBehaviour = "pause" | "ignore";

export interface SwitcherObsControllerConfig {
	moduleId: string;
	failBehaviour: SwitcherFailBehaviour;
}

/** Thresholds: bitrate in kbps, rtt in ms. */
export interface SwitcherTriggers {
	low: number;
	offline: number;
	rtt: number;
}

/** The scenes the switcher may move between. */
export interface SwitcherScenes {
	normal: string;
	low: string;
	offline: string;
}

/** The automatic-switching engine's own settings. */
export interface SwitcherEngineConfig {
	/** Master switch for the automatic switching (the module `enabled` flag is separate). */
	bitrateSwitcherEnabled: boolean;
	/** Ignore metrics while OBS is not streaming. */
	onlySwitchWhenStreaming: boolean;
	/** Return to the normal scene without the retry delay. */
	instantlySwitchOnRecover: boolean;
	/** Consecutive bad polls before a switch happens. */
	retryAttempts: number;
	/** Sampling period of the sources, ms. */
	pollIntervalMs: number;
	triggers: SwitcherTriggers;
	switchingScenes: SwitcherScenes;
}

/** Scenes the operator manages manually; the switcher never leaves the privacy scene. */
export interface SwitcherOptionalScenes {
	starting: string;
	ending: string;
	privacy: string;
}

/**
 * Full switcher settings (persisted under settings.modules["obs-controller"].switcher).
 * The OBS-level `switcherEnabled` parameter (sibling of `switcher`) decides
 * whether the switcher runs; this object carries only its settings.
 */
export interface LowBitrateSwitcherConfig {
	sources: LowBitrateSwitcherSources;
	obsController: SwitcherObsControllerConfig;
	switcher: SwitcherEngineConfig;
	optionalScenes: SwitcherOptionalScenes;
	logToFile: boolean;
}

/** Factory defaults for the low-bitrate switcher; a fresh device starts with it idle. */
export function defaultLowBitrateSwitcherConfig(): LowBitrateSwitcherConfig {
	return {
		sources: {
			encoder: { enabled: false, moduleId: "encoder" },
			relay: { enabled: false, moduleId: "relay" },
			combined: {
				enabled: false,
				moduleId: "encoder-relay",
				fieldMap: { bitrate: "bitrate", rtt: "rtt", connected: "connected", streaming: "streaming" },
			},
		},
		obsController: { moduleId: "obs-controller", failBehaviour: "pause" },
		switcher: {
			bitrateSwitcherEnabled: true,
			onlySwitchWhenStreaming: false,
			instantlySwitchOnRecover: true,
			retryAttempts: 5,
			pollIntervalMs: 1000,
			triggers: { low: 500, offline: 400, rtt: 1500 },
			switchingScenes: { normal: "LIVE", low: "LOW", offline: "BRB" },
		},
		optionalScenes: { starting: "STARTING", ending: "ENDING", privacy: "PRIVACY" },
		logToFile: true,
	};
}

/**
 * Merge a raw config slice (RPC body / persisted settings) with the factory
 * defaults and validate it field by field. Returns the normalized config, or
 * null when the input is not a settings object at all (the caller keeps the
 * module disabled then — an unparseable config must not switch scenes).
 */
export function normalizeSwitcherConfig(raw: unknown): LowBitrateSwitcherConfig | null {
	if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
	const r = raw as Record<string, unknown>;
	const out = structuredClone(defaultLowBitrateSwitcherConfig());

	const asBool = (v: unknown): boolean | undefined => (typeof v === "boolean" ? v : undefined);
	const asNonEmptyString = (v: unknown): string | undefined =>
		typeof v === "string" && v.trim() !== "" ? v : undefined;
	const asInt = (v: unknown, min: number, max: number): number | undefined =>
		typeof v === "number" && Number.isInteger(v) && v >= min && v <= max ? v : undefined;

	const asObject = (v: unknown): Record<string, unknown> | null =>
		v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : null;

	// Sources
	const sources = asObject(r.sources) ?? {};
	for (const key of ["encoder", "relay"] as const) {
		const s = asObject(sources[key]) ?? {};
		const b = asBool(s.enabled);
		if (b !== undefined) out.sources[key].enabled = b;
		const id = asNonEmptyString(s.moduleId);
		if (id) out.sources[key].moduleId = id;
	}
	const combined = asObject(sources.combined) ?? {};
	const cb = asBool(combined.enabled);
	if (cb !== undefined) out.sources.combined.enabled = cb;
	const cid = asNonEmptyString(combined.moduleId);
	if (cid) out.sources.combined.moduleId = cid;
	const fm = asObject(combined.fieldMap) ?? {};
	for (const k of ["bitrate", "rtt", "connected", "streaming"] as const) {
		const f = asNonEmptyString(fm[k]);
		if (f) out.sources.combined.fieldMap[k] = f;
	}

	// OBS controller
	const oc = asObject(r.obsController) ?? {};
	const ocId = asNonEmptyString(oc.moduleId);
	if (ocId) out.obsController.moduleId = ocId;
	if (oc.failBehaviour === "pause" || oc.failBehaviour === "ignore") out.obsController.failBehaviour = oc.failBehaviour;

	// Engine
	const sw = asObject(r.switcher) ?? {};
	const swEnabled = asBool(sw.bitrateSwitcherEnabled);
	if (swEnabled !== undefined) out.switcher.bitrateSwitcherEnabled = swEnabled;
	const oss = asBool(sw.onlySwitchWhenStreaming);
	if (oss !== undefined) out.switcher.onlySwitchWhenStreaming = oss;
	const isr = asBool(sw.instantlySwitchOnRecover);
	if (isr !== undefined) out.switcher.instantlySwitchOnRecover = isr;
	const ra = asInt(sw.retryAttempts, 1, 100);
	if (ra !== undefined) out.switcher.retryAttempts = ra;
	const pi = asInt(sw.pollIntervalMs, 200, 3_600_000);
	if (pi !== undefined) out.switcher.pollIntervalMs = pi;
	const trig = asObject(sw.triggers) ?? {};
	for (const k of ["low", "offline", "rtt"] as const) {
		const v = asInt(trig[k], 0, 100_000_000);
		if (v !== undefined) out.switcher.triggers[k] = v;
	}
	const wc = asObject(sw.switchingScenes) ?? {};
	for (const k of ["normal", "low", "offline"] as const) {
		const s = asNonEmptyString(wc[k]);
		if (s) out.switcher.switchingScenes[k] = s;
	}
	const osc = asObject(r.optionalScenes) ?? {};
	for (const k of ["starting", "ending", "privacy"] as const) {
		const s = asNonEmptyString(osc[k]);
		if (s) out.optionalScenes[k] = s;
	}

	const ltf = asBool(r.logToFile);
	if (ltf !== undefined) out.logToFile = ltf;

	return out;
}
