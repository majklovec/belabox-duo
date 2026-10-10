/*
 * Local types for the obs-controller module (never imported by the core or
 * other modules): structural copies of the core bag and the frontend
 * registration. Wire types live in public/types.ts (the documented wire
 * vocabulary).
 */

/** The slice of the core bag this module uses. */
export interface MCore {
	config: { LOG_FILE: string };
	state: {
		settings: {
			modules?: Record<string, {
				enabled?: boolean;
				obsUrl?: string;
				obsPassword?: string;
				sceneEvents?: boolean;
				[key: string]: unknown;
			}>;
		};
	};
	saveState(): Promise<void>;
	logEvent(level: "info" | "warn" | "error", section: string, message: string): void;
	ApiError: new (message: string, code?: number) => Error & { code: number };
	/** Capability bus (capability names, never module ids). */
	requireCapability: <T = unknown>(name: string) => T;
	moduleById: (id: string) => { id: string; status?: () => Promise<Record<string, unknown>> } | undefined;
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
