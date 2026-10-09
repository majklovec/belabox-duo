/* Local types for the modems module (never imported by the core or other modules). */

/** One enumerated ModemManager modem (the status `modems` array item). */
export interface ModemInfo {
	index: number;
	path: string;
	state: string;
	powerState: string;
	model?: string;
	manufacturer?: string;
	imei?: string;
	primaryPort?: string;
	deviceId?: string;
	simPath?: string;
	operatorName?: string;
	registrationState?: string;
	accessTech?: string;
	signalQuality?: number;
}

/** The slice of the core bag this module uses. */
export interface ModemsCore {
	run(cmd: string, args: string[], ignoreError?: boolean): Promise<string>;
}

/** The context the registry passes to `start`. */
export interface Mctx {
	config: Record<string, unknown>;
	emit(event: string, data: unknown): void;
	log(section: string, message: string): void;
	core: ModemsCore;
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
