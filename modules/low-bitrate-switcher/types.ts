/*
 * Local types for the low-bitrate-switcher module (never imported by the core
 * or other modules). The wire shapes come from public/types.ts (the documented
 * wire vocabulary); the core bag and the obs capability are structural copies.
 */

/** Devices each source slot may read from, by registry role. */
export const SWITCHER_SOURCE_ROLES: { encoder: readonly string[]; relay: readonly string[] } = {
	encoder: ["encoder", "combined"],
	relay: ["relay", "combined"],
};

/** The obs module's service record (capability `obs.controller`), structurally. */
export interface ObsServices {
	/** The module's live OBS websocket (null: module not started / no url). */
	client(): {
		connected: boolean;
		identified: boolean;
		sendRequest(request: {
			requestType: string;
			requestId: string;
			requestData: Record<string, unknown>;
		}): Promise<{ requestStatus: { result: boolean }; responseData?: Record<string, unknown> }>;
		on(event: string, handler: (data: Record<string, unknown>) => void): void;
	} | null;
}

/** The slice of the core bag this module uses. */
export interface MCore {
	config: { LOG_FILE: string };
	state: {
		settings: {
			modules?: Record<string, { enabled?: boolean; [key: string]: unknown }>;
		};
	};
	saveState(): Promise<void>;
	logEvent(level: "info" | "warn" | "error", section: string, message: string): void;
	ApiError: new (message: string, code?: number) => Error & { code: number };
	/** Capability bus (capability names, never module ids). */
	requireCapability: <T = unknown>(name: string) => T;
	/** The control server's registry — the devices registered on it. */
	listDevices(): Promise<Array<{ id: string; hostname?: string; role?: string; online: boolean }>>;
	/** Request a method on another registered device (server-mediated). */
	requestDevice(deviceId: string, method: string, params?: Record<string, unknown>): Promise<unknown>;
}

/** The context the registry passes to `start`. */
export interface Mctx {
	config: Record<string, unknown>;
	emit(event: string, data: unknown): void;
	log(section: string, message: string): void;
	core: MCore;
}

/** A browser-side module registration (frontend). Local copy so a module never
 * imports across boundaries; the frontend registry narrows it. */
export interface BridgedModule {
	id: string;
	title: string;
	icon?: string;
	kind: "device-card";
	component: unknown;
	defaultSize: { w: number; h: number };
	minSize: { w: number; h: number };
	maxSize?: { w: number; h: number };
	handleEvent?(event: string, data: unknown): void;
}
