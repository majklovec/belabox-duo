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
