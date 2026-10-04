/* Wire types shared by the device UI, the device list and the control server. */
import type { AudioSource, CeraConfig, EncoderState, ModemInfo } from "../modules/types";
import type { Language } from "../src/i18n";
import type { Iface, ModemConfig } from "../src/routing";
import type { SrtlaState } from "../src/srtla";
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
export interface KickStatsModuleView {
	enabled: boolean;
	channel: string;
}
export interface KickChatModuleView {
	enabled: boolean;
	channel: string;
	token: string | { configured: boolean };
}
export interface ModulesView {
	relay: { enabled: boolean };
	encoder: { enabled: boolean };
	"obs-controller": ObsModuleView;
	"kick-stats": KickStatsModuleView;
	"kick-chat": KickChatModuleView;
}
/** A dashboard widget type, backed by (or showing) one of a device's modules. */
export type WidgetType = "obs" | "stats" | "status" | "relay" | "encoder" | "kick-stats" | "kick-chat";

/**
 * Server-side dashboards: composed in the control server's dashboards page from
 * widgets that each pull one module's view off a selected device.
 */
export interface ServerDashboardWidget {
	/** Stable widget id, assigned by the server */
	id: string;
	/** The device this widget's module data comes from */
	deviceId: string;
	type: WidgetType;
	name: string;
	/** 12-column grid span: 4, 6 or 12 */
	width: 4 | 6 | 12;
}
export interface ServerDashboard {
	id: string;
	name: string;
	widgets: ServerDashboardWidget[];
}
/** Latest kick.stats event (Kick channel stats poll). */
export interface KickStats {
	viewers?: number;
	followers?: number;
	isLive?: boolean;
	title?: string;
	/** Device-side timestamp of the poll */
	at: number;
}
/** One Kick chat message (Kick `id` used for deduplication). */
export interface KickChatMessage {
	id: string | number;
	username?: string;
	badge?: { id?: string };
	text?: string;
	ts?: number;
}

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
