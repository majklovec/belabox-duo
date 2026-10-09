/*
 * Wire types shared by the device UI, the device list and the control server.
 *
 * Self-contained: a module may import this file (it is the documented wire
 * vocabulary), the modules/ tree may not contribute to it anymore — the old
 * shared contract (modules/types.ts) is deleted by the self-containment
 * refactor. Runtime constants that belong to a single module live there now.
 */
import type { Language } from "../src/i18n";
import type { Iface, ModemConfig } from "../src/routing";
import type { SrtlaControlState } from "../src/srtlaControl";
import type { SrtlaOptions, SrtlaTarget, StreamTarget } from "../src/state";
import type { Role } from "../src/validate";

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
// Encoder wire types (shared by the encoder module, state.ts, the UI)
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

// ----------------------------------------------------------------------
// Channel widget wire shapes (kick/tiktok/twitch/youtube modules).
//
// Device-independent dashboard widgets: state lives in the dashboards API,
// one backend instance per module serves all widgets of that type, and the
// browser renders from the dashboard websocket push. The shapes below are
// what the hub delivers over the websocket (RemoteDeviceState.kick).
// ----------------------------------------------------------------------

/** Widget types owned by a channel widget module (device-independent widgets). */
export const WIDGET_MODULE_IDS = ["kick-stats", "kick-chat", "tiktok-chat", "twitch-chat", "youtube-chat"] as const;
export type WidgetModuleId = (typeof WIDGET_MODULE_IDS)[number];

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

// ----------------------------------------------------------------------
// Low-bitrate switcher wire types (owned by the obs module; status + UI)
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

export type { Role, StreamTarget };
export type { SrtlaLinkStats, SrtlaMode, SrtlaStats, SrtlaStatsEvent } from "../src/srtlaControl";

export interface Status {
	role: Role;
	setupRequired: boolean;
	state: {
		selection: ModemConfig;
		srtla: SrtlaState;
		srtlaTarget?: SrtlaTarget;
		srtlaOptions: SrtlaOptions;
		encoder: EncoderState;
		stream?: StreamTarget;
		autostart: boolean;
	};
	interfaces: Iface[];
	selected: Iface[];
	modems: ModemInfo[];
	audioSources: AudioSource[];
	uplinksFile: string;
	srtlaControl: SrtlaControlState;
	monitor: { running: boolean; reloadMode: string };
	ceracoder: CeraConfig | null;
	/** Live state of the low-bitrate switcher (null when the module is stopped). */
	lowBitrateSwitcher?: SwitcherStatus | null;
	/** Module system: enabled flags + non-secret settings (secrets come back as `{configured}`). */
	modules: ModulesView;
}

export interface ObsModuleView {
	enabled: boolean;
	obsUrl: string;
	obsPassword: string | { configured: boolean };
	sceneEvents: boolean;
	/** Master switch for the low-bitrate switcher hosted by the obs module. */
	switcherEnabled: boolean;
	/** The low-bitrate switcher settings hosted by the obs module. */
	switcher: LowBitrateSwitcherConfig;
}
export interface ModulesView {
	relay: { enabled: boolean };
	encoder: { enabled: boolean };
	"obs-controller": ObsModuleView;
}
/** A dashboard widget type, backed by (or showing) one of a device's modules. */
export type WidgetType = "obs" | "stats" | "status" | "relay" | "encoder" | "combined" | "kick-stats" | "kick-chat" | "tiktok-chat" | "twitch-chat" | "youtube-chat";

/**
 * Server-side dashboards: composed in the control server's dashboards page from
 * widgets that each pull one module's view off a selected device.
 */
export interface ServerDashboardWidget {
	/** Stable widget id, assigned by the server */
	id: string;
	/** The device this widget's module data comes from ("" for kick widgets) */
	deviceId: string;
	type: WidgetType;
	name: string;
	/** Grid position (0-indexed, 12 columns) and extent, in grid units. */
	x: number;
	y: number;
	w: number;
	h: number;
	/** Hidden widgets keep their position/size; they are not rendered. */
	visible: boolean;
	/** Channel-widget modules only: their own data source parameters. The
	 * parameter names are declared by the widget module's `configFields` (the
	 * core stores an opaque record and never names its fields). */
	config?: Record<string, string>;
}
export interface ServerDashboard {
	id: string;
	name: string;
	/** Monotonic; bumped on every update. Used for optimistic concurrency. */
	version: number;
	widgets: ServerDashboardWidget[];
	/** Columns in the grid. Fixed at 12 for now; stored for forward-compat. */
	columns: number;
}

/** Grid size in units of one widget: `{w, h}`. */
export interface GridSize {
	w: number;
	h: number;
}
/** Latest kick.stats event / one Chat Kick message — wire shapes owned by the
 * widget module contract (the hub delivers them over the dashboard websocket). */
export type KickStats = StatsLive;
export type KickChatMessage = ChatLive;

/** Sent only when the UI is served by the control server (server.ts) for a remote device. */
export interface DeviceInfo {
	/** Stable device uuid (the registry key on the control server) */
	id: string;
	role?: Role;
	online: boolean;
	connectedAt?: number;
	lastSeen?: number;
	address?: string;
	/** Display name; hostnames change, the id does not */
	hostname?: string;
	/** Device header color, used by the list's heartbeat dot */
	color?: string;
	/** UI language the device was set to (see LANGUAGE_INFO in src/i18n.ts) */
	language?: Language;
	/** App build stamp (git short SHA) the device reports in its hello; undefined on builds predating version reporting */
	version?: string;
}

/** One row of the control server's `GET /api/devices`. */
export interface DeviceSummary extends DeviceInfo {
	statusAt?: number;
	srtla?: SrtlaState;
	encoder?: EncoderState;
	/** Enabled modules, offered by the dashboards page when composing widgets */
	modules?: ModulesView;
	/** Live srtla_send totals, while it pushes link stats. */
	bitrate?: number;   // bytes/s across all links
	/** Configured encoder maximum, available even without SRTLA telemetry. */
	maxBitrate?: number; // kbps
	activeLinks?: number;
	totalLinks?: number;
}
