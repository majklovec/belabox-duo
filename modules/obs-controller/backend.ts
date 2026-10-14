/*
 * obs-controller module: owns the ObsClient connection to the paired OBS
 * Studio and forwards its events into the belabox event stream (pushed with a
 * `module: "obs-controller"` tag). The obs.* API methods in methods.ts
 * dispatch their raw requests straight to this client.
 *
 * Its live client is exposed to other modules over the capability bus
 * (the low-bitrate switcher drives scene changes through it — no second
 * OBS websocket).
 *
 * Self-contained: wire types live in public/types; the only core edge is the bag.
 */
import { randomUUID } from "node:crypto";
import { appendFile, mkdir } from "node:fs/promises";
import { dirname, join } from "node:path";
import { z } from "zod";
import {
	DEFAULT_EVENT_SUBSCRIPTIONS,
	EventSubscription,
	OBS_DISCONNECTED_EVENT,
	ObsClient,
	type ObsEvent,
	type ObsRequest,
	type ObsRequestBatch,
} from "../../src/obs/client";
import type { SwitcherConfig, SwitcherMetrics } from "../../public/types";
import { SwitcherEngine, type ObsSnapshot } from "./switcher-engine";
import { collectSrtSample, type SrtBaseline } from "./srt-metrics";
import type { MCore, Mctx } from "./types";

const SECTION = "LowBitrateSwitcher";

/** Core bag, filled at bind (discovery) and re-filled at start (a module may not import the core directly). */
let core: MCore;

// op5 events forwarded to the UI; the ones an operator dashboard reacts to.
// OBS v5 output events carry no "Current" prefix — they are StreamStateChanged /
// RecordStateChanged (the names the dashboards already listen for), unlike the
// scene/input events above. InputVolumeMeters feeds the card's VU meter,
// InputMute keeps its mute button honest.
const FORWARDED_EVENTS = [
	"CurrentProgramSceneChanged",
	"CurrentPreviewSceneChanged",
	"CurrentProgramSceneItemChanged",
	"CurrentTransitionChanged",
	"CurrentProgramInputChanged",
	"ActiveInputChanged",
	"SceneItemAdded",
	"SceneItemRemoved",
	"MediaInputPlaybackStateChanged",
	"MediaInputStateChanged",
	"StreamStateChanged",
	"RecordStateChanged",
	"InputVolumeMeters",
	"InputMute",
	"InputMuteStateChanged",
] as const;

const EVENT_SUBSCRIPTION_NAMES: Record<string, number> = {
	General: EventSubscription.General,
	Config: EventSubscription.Config,
	Scenes: EventSubscription.Scenes,
	Inputs: EventSubscription.Inputs,
	Transitions: EventSubscription.Transitions,
	Filters: EventSubscription.Filters,
	Outputs: EventSubscription.Outputs,
	SceneItems: EventSubscription.SceneItems,
	MediaInputs: EventSubscription.MediaInputs,
	Vendors: EventSubscription.Vendors,
	Ui: EventSubscription.Ui,
	InputVolumeMeters: EventSubscription.InputVolumeMeters,
	InputActiveStateChanged: EventSubscription.InputActiveStateChanged,
	InputShowStateChanged: EventSubscription.InputShowStateChanged,
	SceneItemTransformChanged: EventSubscription.SceneItemTransformChanged,
};

/** Case-insensitive: the map is keyed by upper-cased event names. */
const EVENT_SUBSCRIPTION_LOOKUP: Record<string, number> = Object.fromEntries(
	Object.entries(EVENT_SUBSCRIPTION_NAMES).map(([name, bit]) => [name.toUpperCase(), bit]),
);

let obsClient: ObsClient | null = null;

/** The live client, or a 409 asking the operator to enable the module. */
const requiredClient = (): ObsClient => {
	if (!obsClient) throw new core.ApiError("The obs-controller module is not running", 409);
	return obsClient;
};

/**
 * obs-controller services consumed by the core (the method dispatcher in
 * methods.ts) — exposed through the capability bus under "obs".
 */
export const obsServices = {
	/** The live client (null when the module is not running). */
	client: (): ObsClient | null => obsClient,
	/** OR of the event bits for the given names (case-insensitive; unknown names are skipped). */
	subscriptionMask(names: string[]): number {
		return names.reduce((acc, name) => acc | (EVENT_SUBSCRIPTION_LOOKUP[name.toUpperCase()] ?? EventSubscription.None), 0);
	},
	/**
	 * Apply persisted config fields (url / password / sceneEvents / enabled);
	 * caller saves the state. Only fields present in `config` are touched.
	 */
	configure(config: Record<string, unknown>): void {
		const obs = core.state.settings.modules?.["obs-controller"];
		if (!obs) return;
		if (typeof config.enabled === "boolean") obs.enabled = config.enabled;
		if (typeof config.obsUrl === "string") obs.obsUrl = config.obsUrl;
		if (typeof config.obsPassword === "string") obs.obsPassword = config.obsPassword;
		if (typeof config.sceneEvents === "boolean") obs.sceneEvents = config.sceneEvents;
	},
};

const forward = (name: string, emit: Mctx["emit"]) =>
	(_data: Record<string, unknown>, event: ObsEvent) =>
		emit("obs.event", { eventType: name, eventIntent: event.eventIntent, eventData: event.eventData });

async function teardown(): Promise<void> {
	stopEngine();
	obsClient?.disconnect();
	obsClient = null;
}

// ============================================================================
// Low-bitrate switcher — runs on this module's client. It polls the SRTLA
// source's vendor stats and drives scene changes through the same websocket.
// Its settings live in this module's slice (settings.modules["obs-controller"]).

const fileLog = (): string => join(dirname(core.config.LOG_FILE), "lowBitrateSwitcher.log");

let engine: SwitcherEngine | null = null;
/** The active switcher settings (kept to hot-apply without re-reading state). */
let cfg: SwitcherConfig;
/** Baseline of the SRT byte counters (reset on each poll for the bitrate delta). */
let srtBaseline: SrtBaseline | null = null;
/** The program scene / streaming flag as last reported by the client. */
let scene: string | null = null;
let streaming = false;
/** The client the event listeners are attached to (a fresh client per start). */
let attachedTo: ObsClient | null = null;
let fileLogBroken = false;
/** The registry-provided emitter; the engine's status rides on this event. */
let emit: (event: string, data: unknown) => void = () => {};

function moduleLog(level: "info" | "warn" | "error", message: string): void {
	core.logEvent(level, SECTION, message);
	if (cfg?.logToFile && !fileLogBroken) {
		const line = `${JSON.stringify({ at: Date.now(), level, message })}\n`;
		const path = fileLog();
		mkdir(dirname(path), { recursive: true })
			.then(() => appendFile(path, line))
			.catch(() => {
				fileLogBroken = true;
			});
	}
}

/**
 * The module's switcher slice (the obs-controller slice; the switcher rides on
 * OBS). Incomplete slices (no `obsSourceName`) resolve to null: the engine
 * idles until the card form saves.
 */
function moduleSlice(): SwitcherConfig | null {
	const stored = core.state.settings.modules?.["obs-controller"] as Record<string, unknown> | undefined;
	return stored && typeof stored["obsSourceName"] === "string" ? (stored as unknown as SwitcherConfig) : null;
}

/**
 * One SRT sample read from OBS (see srt-metrics.ts for the vendor protocol and
 * the recent-bitrate delta math). Returns null when the client is down or the
 * query fails — the engine then sees a metrics gap and stays put.
 */
async function collectSrtMetrics(): Promise<SwitcherMetrics | null> {
	if (!obsClient) return null;
	const sourceName = (cfg?.obsSourceName ?? "").trim();
	if (!sourceName) return null;
	const { sample, baseline } = await collectSrtSample(obsClient, sourceName, srtBaseline, streaming, srtWarn);
	srtBaseline = baseline;
	return sample;
}

/** Throttled SRT warning (a bad source name would otherwise log every poll). */
let lastSrtWarnAt = 0;
function srtWarn(message: string): void {
	const now = Date.now();
	if (now - lastSrtWarnAt < 30_000) return;
	lastSrtWarnAt = now;
	moduleLog("warn", message);
}

/** The client's obs snapshot for the engine (null: client down). */
function obsSnapshot(): ObsSnapshot | null {
	if (!obsClient) return null;
	return {
		connected: obsClient.connected && obsClient.identified,
		streaming,
		scene,
	};
}

async function obsSetScene(name: string): Promise<boolean> {
	if (!obsClient) return false;
	try {
		const res = await obsClient.sendRequest({
			requestType: "SetCurrentProgramScene",
			requestId: randomUUID(),
			// obs-websocket 5 wants camelCase `sceneName` (PascalCase is rejected).
			requestData: { sceneName: name },
		});
		return res.requestStatus.result;
	} catch {
		return false;
	}
}

/** Warm the scene / streaming tracking from OBS itself. */
async function obsWarmStart(): Promise<void> {
	const client = obsClient;
	if (!client) return;
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
 * Attach the scene / streaming event listeners to this module's client (a fresh
 * client on every start, so the set is re-created each time).
 */
function attachObsEvents(): void {
	const client = obsClient;
	if (!client) return;
	if (attachedTo === client) return;
	attachedTo = client;
	client.on("CurrentProgramSceneChanged", (d: Record<string, unknown>) => {
		scene = typeof d["CurrentProgramSceneName"] === "string" ? (d["CurrentProgramSceneName"] as string) : scene;
	});
	client.on("StreamStateChanged", (d: Record<string, unknown>) => {
		if (typeof d["OutputState"] === "number") streaming = (d["OutputState"] as number) === 1;
	});
}

function push(): void {
	emit("lowBitrateSwitcher.state", engine?.status() ?? null);
}

async function startEngine(): Promise<void> {
	const slice = moduleSlice();
	if (!slice) {
		moduleLog("warn", "no OBS SRT source set; switcher idle until the card form saves");
		return;
	}
	cfg = slice;
	srtBaseline = null;
	engine = new SwitcherEngine(cfg, {
		obs: obsSnapshot,
		setScene: obsSetScene,
		metrics: collectSrtMetrics,
		log: moduleLog,
		onUpdate: () => push(),
		now: () => Date.now(),
	});
	engine.start();
	attachObsEvents();
	void obsWarmStart();
	moduleLog("info", `started (OBS source: "${cfg.obsSourceName}")`);
}

function stopEngine(): void {
	engine?.stop();
	engine = null;
	attachedTo = null;
	srtBaseline = null;
}

/**
 * Apply the switcher settings (the lowBitrateSwitcher.save body) over the
 * obs-controller slice: a field keeps the previous value when the sent one is
 * not of the expected shape. The form is the source of the defaults.
 */
function applyConfig(raw: Record<string, unknown>): SwitcherConfig {
	const slice = (core.state.settings.modules ??= {})["obs-controller"] ?? {};
	const base: SwitcherConfig = cfg ?? (slice as unknown as SwitcherConfig);
	const out: SwitcherConfig = structuredClone(base);
	if (typeof raw["obsSourceName"] === "string") out.obsSourceName = raw["obsSourceName"];
	if (raw["failBehaviour"] === "pause" || raw["failBehaviour"] === "ignore") out.failBehaviour = raw["failBehaviour"];
	if (raw["autoSwitch"] === true) out.autoSwitch = true;
	else if (raw["autoSwitch"] === false) out.autoSwitch = false;
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
			if (typeof t[key] === "number" && Number.isFinite(t[key]) && (t[key] as number) >= 0) out.triggers[key] = t[key];
		}
	}
	for (const key of ["normal", "low", "offline"] as const) {
		if (raw["scenes"] && typeof raw["scenes"] === "object" && typeof (raw["scenes"] as Record<string, unknown>)[key] === "string")
			out.scenes[key] = (raw["scenes"] as Record<string, unknown>)[key] as string;
	}
	for (const key of ["starting", "ending", "privacy"] as const) {
		if (raw["optionalScenes"] && typeof raw["optionalScenes"] === "object" && typeof (raw["optionalScenes"] as Record<string, unknown>)[key] === "string")
			out.optionalScenes[key] = (raw["optionalScenes"] as Record<string, unknown>)[key] as string;
	}
	// Persist the applied slice (the whole switcher lives in the obs slice now).
	Object.assign(slice, out);
	core.state.settings.modules["obs-controller"] = slice;
	return out;
}

export default {
	kind: "device",
	id: "obs-controller",
	title: "OBS",
	configSchema: z.object({
		enabled: z.boolean().optional(),
		obsUrl: z.string().optional(),
		obsPassword: z.string().optional(),
		sceneEvents: z.boolean().optional(),
		// The low-bitrate switcher settings (this module owns the engine).
		switcherEnabled: z.boolean().optional(),
		obsSourceName: z.string().optional(),
		failBehaviour: z.string().optional(),
		autoSwitch: z.boolean().optional(),
		onlySwitchWhenStreaming: z.boolean().optional(),
		instantlySwitchOnRecover: z.boolean().optional(),
		retryAttempts: z.number().optional(),
		pollIntervalMs: z.number().optional(),
		triggers: z.record(z.string(), z.unknown()).optional(),
		scenes: z.record(z.string(), z.unknown()).optional(),
		optionalScenes: z.record(z.string(), z.unknown()).optional(),
		logToFile: z.boolean().optional(),
	}).passthrough(),
	secretFields: ["obsPassword"],
	bind(c: MCore) {
		core = c;
	},
	async start(ctx: Mctx) {
		core = ctx.core;
		emit = ctx.emit;
		await teardown();
		const cfg = ctx.config;
		if (cfg["enabled"] !== true) return;
		if (typeof cfg["obsUrl"] !== "string" || !cfg["obsUrl"]) {
			ctx.log("obs-controller", "enabled but no obsUrl set; module idle");
			return;
		}
		const obsPassword = cfg["obsPassword"];
		obsClient = new ObsClient({
			url: cfg["obsUrl"],
			...(obsPassword ? { password: obsPassword as string } : {}),
			// The VU meter needs the InputVolumeMeters bit (absent from the defaults);
			// InputMute rides in on the Inputs bit below.
			eventSubscriptions:
				cfg["sceneEvents"] === true
					? DEFAULT_EVENT_SUBSCRIPTIONS | EventSubscription.InputVolumeMeters
					: EventSubscription.None,
			log: (msg, ...rest) => ctx.log("obs-controller", [msg, ...rest].map(String).join(" ")),
		});
		for (const name of FORWARDED_EVENTS) obsClient.on(name, forward(name, ctx.emit));
		// Synthetic drop event (clearly marked as non-standard by the client)
		obsClient.on(OBS_DISCONNECTED_EVENT, () => ctx.emit("obs.event", { disconnected: true }));
		// The low-bitrate switcher rides on this client. It is on by default
		// (the module's enabled flag is the master switch) and can be turned
		// off with its own switcherEnabled flag.
		if (cfg["switcherEnabled"] !== false) await startEngine();
	},
	async stop() {
		await teardown();
	},
	methods: ["obs.request", "obs.requestBatch", "obs.setEventSubscriptions", "lowBitrateSwitcher.save"] as const,
	events: ["obs.event", "lowBitrateSwitcher.state"] as const,
	status(): Record<string, unknown> {
		// The low-bitrate switcher's live state (null = not running): the card reads it.
		return { lowBitrateSwitcher: engine?.status() ?? null };
	},
	async dispatch(method: string, params: Record<string, unknown>) {
		switch (method) {
			case "obs.request": {
				const request: ObsRequest = {
					requestType: String(params["requestType"]),
					requestId: String(params["requestId"]),
					requestData: params["requestData"] as Record<string, unknown>,
				};
				// op7 passthrough: the obs-websocket v5 response `d`, statuses unmapped
				return requiredClient().sendRequest(request);
			}
			case "obs.requestBatch": {
				// op9 passthrough: the obs-websocket v5 batch response `d`
				return requiredClient().sendBatch(params as unknown as ObsRequestBatch);
			}
			case "obs.setEventSubscriptions": {
				const intents = Number(params["eventSubscriptions"]);
				requiredClient().setEventSubscriptions(intents);
				return { ok: true, eventSubscriptions: intents };
			}
			case "lowBitrateSwitcher.save": {
				// The form sends the full flat switcher slice; a field that does
				// not match its shape keeps the previous value. It is persisted
				// into this module's slice (the switcher lives on obs-controller).
				const body =
					params["config"] && typeof params["config"] === "object" && !Array.isArray(params["config"])
						? (params["config"] as Record<string, unknown>)
						: params;
				const next = applyConfig(body);
				await core.saveState();
				// Hot-apply: the running engine picks up the new values right away;
				// when it idled (no source set) it starts now.
				if (engine) {
					srtBaseline = null; // the observed source / counters may have changed
					engine.updateConfig(next);
					engine.start();
				} else if (obsClient && next.obsSourceName) {
					cfg = next;
					await startEngine();
				}
				push();
				return { ok: true };
			}
			default:
				throw new core.ApiError(`Unknown method: ${method}`, 404);
		}
	},
	services: {
		capabilities: {
			"obs.controller": obsServices,
		},
	},
};
