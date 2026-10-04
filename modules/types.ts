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
	defaultWidth: "full" | "half" | "third";
	/** React to a pushed event (e.g. "kick.stats"). */
	handleEvent?(event: string, data: unknown): void;
}
