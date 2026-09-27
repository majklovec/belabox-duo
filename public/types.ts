/* Wire types shared by the relay UI, the device list and the control server. */
import type { ModemInfo } from "../src/modems";
import type { Iface, ModemConfig } from "../src/routing";
import type { SrtlaState } from "../src/srtla";
import type { EncoderState } from "../src/encoder";
import type { SrtlaTarget, StreamTarget } from "../src/state";

export type { EncoderState, StreamTarget };
export type { AudioSource, Pipeline } from "../src/encoder";
import type { AudioSource } from "../src/encoder";

export type { Role } from "../src/config";
import type { Role } from "../src/config";

export interface Status {
	role: Role;
	state: {
		selection: ModemConfig;
		srtla: SrtlaState;
		srtlaTarget?: SrtlaTarget;
		encoder: EncoderState;
		stream?: StreamTarget;
		autostart: boolean;
	};
	interfaces: Iface[];
	selected: Iface[];
	modems: ModemInfo[];
	audioSources: AudioSource[];
	uplinksFile: string;
	monitor: { running: boolean; reloadMode: string };
}

/** Sent only when the UI is served by the control server (server/) for a remote device. */
export interface DeviceInfo {
	id: string;
	role?: Role;
	online: boolean;
	connectedAt?: number;
	lastSeen?: number;
	address?: string;
}

/** One row of the control server's `GET /api/devices`. */
export interface DeviceSummary extends DeviceInfo {
	statusAt?: number;
	srtla?: SrtlaState;
	encoder?: EncoderState;
	uplinks?: string[];
	modems?: number;
}
