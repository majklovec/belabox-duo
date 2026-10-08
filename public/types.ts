/* Wire types shared by the device UI, the device list and the control server. */
import type { AudioSource, CeraConfig, EncoderState, ModemInfo, StatsLive, ChatLive, SrtlaState } from "../modules/types";
import type { Language } from "../src/i18n";
import type { Iface, ModemConfig } from "../src/routing";
import type { SrtlaControlState } from "../src/srtlaControl";
import type { SrtlaOptions, SrtlaTarget, StreamTarget } from "../src/state";
import type { Role } from "../src/validate";

export { BITRATE_KBPS } from "../modules/types";
export type { CeraBalancer, CeraConfig, ModemInfo } from "../modules/types";
export type { AudioSource, EncoderConfig, EncoderState, Pipeline } from "../modules/types";
export type { SrtlaLinkStats, SrtlaMode, SrtlaStats, SrtlaStatsEvent } from "../src/srtlaControl";
export type { Role, SrtlaState, StreamTarget };

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
	/** Module system: enabled flags + non-secret settings (secrets come back as `{configured}`). */
	modules: ModulesView;
}

export interface ObsModuleView {
	enabled: boolean;
	obsUrl: string;
	obsPassword: string | { configured: boolean };
	sceneEvents: boolean;
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
export type { ChannelLive, ChatLive, StatsLive } from "../modules/types";

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
	/** Device header color, used for the list's heartbeat dot */
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
