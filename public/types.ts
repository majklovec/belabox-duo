/* Wire types shared by the relay UI, the device list and the control server. */
import type { ModemInfo } from "../src/modems";
import type { Iface, ModemConfig } from "../src/routing";
import type { SrtlaState } from "../src/srtla";
import type { EncoderState } from "../src/encoder";
import type { SrtlaOptions, SrtlaTarget, StreamTarget } from "../src/state";
import type { SrtlaControlState } from "../src/srtlaControl";

export type { EncoderState, StreamTarget };
export type { AudioSource, Pipeline } from "../src/encoder";
export type { SrtlaLinkStats, SrtlaMode, SrtlaStats, SrtlaStatsEvent } from "../src/srtlaControl";
import type { AudioSource } from "../src/encoder";

export type { Role } from "../src/config";
import type { Role } from "../src/config";

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
}

/** Sent only when the UI is served by the control server (server/) for a remote device. */
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
