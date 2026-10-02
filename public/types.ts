/* Wire types shared by the device UI, the device list and the control server. */
import type { CeraConfig } from "../src/encoders/ceracoder";
import type { AudioSource, EncoderState } from "../src/encoder";
import type { Language } from "../src/i18n";
import type { ModemInfo } from "../src/modems";
import type { Iface, ModemConfig } from "../src/routing";
import type { SrtlaState } from "../src/srtla";
import type { SrtlaControlState } from "../src/srtlaControl";
import type { SrtlaOptions, SrtlaTarget, StreamTarget } from "../src/state";
import type { Role } from "../src/validate";

export type { CeraBalancer, CeraConfig } from "../src/encoders/ceracoder";
export type { AudioSource, EncoderState, Pipeline } from "../src/encoder";
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
	/** Live srtla_send totals, while it pushes link stats. */
	bitrate?: number;   // bytes/s across all links
	/** Configured encoder maximum, available even without SRTLA telemetry. */
	maxBitrate?: number; // kbps
	activeLinks?: number;
	totalLinks?: number;
}
