/**
 * Module system — shared type contract.
 *
 * Device modules are the building blocks of a belabox-duo device: each one owns
 * a slice of backend behavior (a subprocess, a poller, a websocket) plus the
 * RPC methods it answers and the events it pushes. The registries
 * (`registry.backend.ts` / `registry.frontend.ts`) are the only consumers the
 * core files (src/methods.ts, src/client.ts, public/ts/app.ts) know about.
 *
 * This file must stay dependency-free: no zod, no mithril, no runtime libs.
 */

/** Runtime services handed to a device module on start. */
export interface ModuleContext {
	/** The module's persisted config slice (settings.modules[<id>], non-secret). */
	config: Record<string, unknown>;
	/** Push an event to connected UIs (frame: {type:"event", event, data, module}). */
	emit(event: string, data: unknown): void;
	/** Log through the device log channel (section = log group, message text). */
	log(section: string, message: string): void;
}

/**
 * A device-side module. `start` must be idempotent-ish (the caller stops before
 * starting on restarts), `stop` is safe to call when never started.
 *
 * `status` is a core-registry extension on top of the base contract: it lets
 * buildStatus() pull each module's contribution (e.g. the modem list, srtla
 * state) without methods.ts importing any concrete module.
 */
export interface DeviceModule {
	id: string;
	title: string;
	/** Declarative config description (informational; validation lives in src/validate.ts). */
	configSchema: unknown;
	/** Config keys that are secrets — masked to {configured} in the status view. */
	secretFields: string[];
	start(ctx: ModuleContext): Promise<void>;
	stop(): Promise<void>;
	/** RPC method names owned by this module (the METHOD_OWNER map in methods.ts). */
	methods: readonly string[];
	/** Event names this module emits. */
	events: readonly string[];
	/** Answer one of `methods`. */
	dispatch(method: string, params: Record<string, unknown>): Promise<unknown>;
	/** Optional fragment merged into the status payload by buildStatus(). */
	status?(): Promise<Record<string, unknown>>;
}

/** ModemManager modem as reported by `mmcli` (shared by routing, status, UI). */
export interface ModemInfo {
	index: number;
	path: string;
	state: string;
	powerState: string;
	signalQuality?: number;
	accessTech?: string;
	operatorName?: string;
	registrationState?: string;
	model?: string;
	manufacturer?: string;
	imei?: string;
	primaryPort?: string;
	deviceId?: string;
	simPath?: string;
}

// ----------------------------------------------------------------------
// Encoder module data types (shared by backend, state.ts, public/types.ts)
// ----------------------------------------------------------------------

/** A GStreamer pipeline file under PIPELINES_DIR. */
export interface Pipeline {
	id: string;       // path relative to PIPELINES_DIR
	group: string;    // first directory component ("" for top-level files)
	name: string;     // file name
	asrc: boolean;    // captures from an ALSA card (source can be changed / removed)
	acodec: boolean;  // encodes AAC (can be switched to Opus)
	overlay: boolean; // has the bitrate text overlay
}

/** An available audio capture source (ALSA card id + display name). */
export interface AudioSource { id: string; name: string; }

/** Complete encoder start / restart configuration (drafts kept in state). */
export interface EncoderConfig {
	pipeline: string;
	host: string;         // SRT destination (the relay, or 127.0.0.1 when combined)
	port: string;
	minBitrate: number;   // kbps
	maxBitrate: number;   // kbps
	latency: number;      // SRT latency, ms
	delay: number;        // audio delay, ms
	streamid?: string;
	audioSource?: string; // ALSA card id, "default" or "none"
	audioCodec?: "aac" | "opus";
	bitrateOverlay?: boolean;
}

/** Live encoder state surfaced through status. */
export interface EncoderState {
	running: boolean;
	pid?: number;
	config?: EncoderConfig;   // last used; kept after stop so the UI can prefill
	startedAt?: number;
	restarts?: number;
	lastError?: string;
}

export type CeraBalancer = "adaptive" | "fixed" | "aimd";

/** Tuning of the adaptive (default) ceracoder balancer. */
export interface AdaptiveTuning {
	incrStep: number;      // Kbps
	decrStep: number;      // Kbps
	incrInterval: number;  // ms
	decrInterval: number;  // ms
}

/** Tuning of the AIMD ceracoder balancer. */
export interface AimdTuning {
	incrStep: number;      // Kbps
	decrMult: number;      // fraction of the bitrate kept on congestion (0-1)
	incrInterval: number;  // ms
	decrInterval: number;  // ms
}

/** Bitrate bounds (kbps) shared by wire validation and the UI, single source. */
export const BITRATE_KBPS = { min: 300, max: 30_000 } as const;

/** ceracoder parameters persisted in the device config (`ceracoder` section). */
export interface CeraConfig {
	balancer: CeraBalancer;
	minBitrate: number;    // Kbps
	adaptive: AdaptiveTuning;
	aimd: AimdTuning;
}

/** Runtime state of srtla_send, published under `state.srtla`. */
export interface SrtlaState {
	running: boolean;
	pid?: number;
	listenPort?: string;
	remoteHost?: string;
	remotePort?: string;
	startedAt?: number;
	lastReloadAt?: number;
	reloadCount?: number;
}

/** A browser-side module: the card component plus the events it reacts to. */
export interface BrowserModule {
	id: string;
	title: string;
	icon?: string;
	/**
	 * Render function `(status) => m.Vnode`. Typed `unknown` here so this file
	 * stays dependency-free; registry.frontend.ts narrows it.
	 */
	component: unknown;
	/** Default grid size `{w, h}` (12-column grid units) when added to a dashboard. */
	defaultSize: { w: number; h: number };
	/** Minimum size the user can resize down to. */
	minSize: { w: number; h: number };
	/** Optional cap. Omit for unbounded. */
	maxSize?: { w: number; h: number };
	/** React to a pushed event (e.g. "kick.stats"). */
	handleEvent?(event: string, data: unknown): void;
}

// ----------------------------------------------------------------------
// Channel widget modules (kick-stats, kick-chat) — wire shapes.
//
// Device-independent dashboard widgets: state lives in the dashboards API,
// one backend instance per module serves all widgets of that type, and the
// browser renders from the dashboard websocket push. The shapes below are
// what the hub delivers over the websocket (RemoteDeviceState.kick); they
// are intentionally structural copies of the browser-side KickStats /
// KickChatMessage in public/types.ts so this file stays dependency-free.
// ----------------------------------------------------------------------

/** One viewer-count sample for the kick-stats line chart (oldest first). */
export interface StatsSample {
	/** Poll time (epoch ms) */
	t: number;
	/** Viewers (0 when the channel is offline) */
	v: number;
}

/** Latest kick.stats sample (the server's Kick channel stats poll). */
export interface StatsLive {
	viewers?: number;
	followers?: number;
	isLive: boolean;
	title?: string;
	/** Current stream category name (e.g. "Just Chatting"). */
	category?: string;
	/** Current stream start time (epoch ms). */
	startTime?: number;
	/** Server-side timestamp of the poll */
	at: number;
	/** Recent viewer samples (oldest first), capped by the poller. */
	series?: StatsSample[];
}

/** One Kick chat message (Kick message id used for deduplication). */
export interface ChatLive {
	id: string | number;
	username?: string;
	/** The sender's Kick identity color (hex), for username display. */
	color?: string;
	text?: string;
	type?: string;
	ts?: number;
}

/** One channel's live state on the wire (RemoteDeviceState.kick). */
export interface ChannelLive {
	stats?: StatsLive | null;
	chat?: ChatLive[];
	/** kick-chat: the hub's websocket for this channel was open. */
	connected?: boolean;
}

/**
 * Serialize an event frame for the module websockets ({event, data} inside
 * the device protocol's envelope). Shared by the widget module backends.
 */
export const eventFrame = (event: string, data: unknown): string => JSON.stringify({ type: "event", event, data });

// ----------------------------------------------------------------------
// Low-bitrate switcher module (shared by backend, state.ts, public/types.ts)
// ----------------------------------------------------------------------

/** The switcher's state machine states — each maps to a scene. */
export type SwitcherState = "NORMAL" | "LOW" | "OFFLINE";

/**
 * One merged metrics sample from the active sources. A field is null when no
 * active source provides it (its triggers are skipped, not treated as a fault).
 */
export interface SwitcherMetrics {
	/** Live stream bitrate in kbps (null: not available). */
	bitrateKbps: number | null;
	/** Round-trip time in ms (null: not available). */
	rttMs: number | null;
	/** Upstream connected (null: no source reports it). */
	connected: boolean | null;
	/** Encoder / stream is live (null: not available). */
	streaming: boolean | null;
}

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

/**
 * Which sources are active after resolution (combined takes precedence over
 * encoder/relay). Used by the status so the card can show what feeds the engine.
 */
export interface SwitcherActiveSources {
	encoder: string | null;
	relay: string | null;
	combined: string | null;
}

/** The module's live state, merged into the status payload and pushed per change. */
export interface SwitcherStatus {
	/** Module started with a valid config and at least one source available. */
	active: boolean;
	/** The state the engine currently acts as. */
	state: SwitcherState;
	/** What the latest poll wants (differs from `state` while retrying). */
	desiredState: SwitcherState;
	/** Consecutive bad polls toward the next switch (0 when stable). */
	retryCount: number;
	/** Last known OBS program scene (null: not sampled yet / controller down). */
	currentScene: string | null;
	/** OBS streaming flag as last reported by the controller. */
	streaming: boolean;
	/** The selected obs-controller is identified (websocket up). */
	obsConnected: boolean;
	sources: SwitcherActiveSources;
	/** Last successful poll (epoch ms; 0 when none). */
	updatedAt: number;
}

/** Factory defaults; a fresh device starts with the switcher idle. */
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


