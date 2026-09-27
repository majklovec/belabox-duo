/* Wire types shared by the relay UI, the device list and the control server. */
import type { ModemInfo } from "../src/modems";
import type { Iface, ModemConfig } from "../src/routing";
import type { SrtlaState } from "../src/srtla";

export interface Status {
	state: { selection: ModemConfig; srtla: SrtlaState };
	interfaces: Iface[];
	selected: Iface[];
	modems: ModemInfo[];
	uplinksFile: string;
	monitor: { running: boolean; reloadMode: string };
}

/** Sent only when the UI is served by the control server (server/) for a remote device. */
export interface DeviceInfo {
	id: string;
	online: boolean;
	connectedAt?: number;
	lastSeen?: number;
	address?: string;
}

/** One row of the control server's `GET /api/devices`. */
export interface DeviceSummary extends DeviceInfo {
	statusAt?: number;
	srtla?: SrtlaState;
	uplinks?: string[];
	modems?: number;
}
