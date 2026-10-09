/**
 * The low-bitrate switcher engine — the pure state machine inside the
 * obs-controller module: decides NORMAL / LOW / OFFLINE from metrics,
 * accumulates retry counts, and drives scene switches. No device wiring here
 * (no OBS, no sources, no disk): everything comes through `SwitcherDeps`, so
 * the whole behaviour is unit-testable. Glue: switcher.ts alongside.
 */
import {
	defaultLowBitrateSwitcherConfig,
	type LowBitrateSwitcherConfig,
	type SwitcherMetrics,
	type SwitcherState,
	type SwitcherStatus,
	type SwitcherActiveSources,
} from "./types";

/** One OBS sample as the engine sees it (from the selected controller). */
export interface ObsSnapshot {
	/** The websocket is identified (requests are answerable). */
	connected: boolean;
	streaming: boolean;
	/** Current program scene (null when unknown). */
	scene: string | null;
}

export interface SwitcherDeps {
	/** The obs-controller snapshot; null when the module is missing/down. */
	obs(): ObsSnapshot | null;
	/** Switch the OBS program scene; resolves true when OBS accepted it. */
	setScene(scene: string): Promise<boolean>;
	/** One merged sample of the active sources; null when none is available. */
	metrics(): Promise<SwitcherMetrics | null>;
	/** Resolution outcome of the enabled sources (read once at start). */
	sources(): SwitcherActiveSources;
	log(level: "info" | "warn" | "error", message: string): void;
	/** Notified after every poll cycle (the backend pushes the status then). */
	onUpdate?(): void;
	now(): number;
}

const SCENE_FOR_STATE: Record<SwitcherState, "normal" | "low" | "offline"> = {
	NORMAL: "normal",
	LOW: "low",
	OFFLINE: "offline",
};

/**
 * Pure threshold evaluation (spec: bitrate first, then rtt):
 *   bitrate < offline          -> OFFLINE
 *   bitrate < low / rtt > rtt  -> LOW
 *   otherwise                  -> NORMAL
 * Null metrics (source unavailable) count as NORMAL, never as a switch-off.
 */
export function determineState(metrics: SwitcherMetrics, config: LowBitrateSwitcherConfig): SwitcherState {
	const { bitrateSwitcherEnabled, triggers } = config.switcher;
	if (!bitrateSwitcherEnabled) return "NORMAL";
	if (metrics.connected === false) return "OFFLINE";
	if (metrics.bitrateKbps !== null && metrics.bitrateKbps < triggers.offline) return "OFFLINE";
	if (metrics.bitrateKbps !== null && metrics.bitrateKbps < triggers.low) return "LOW";
	if (metrics.rttMs !== null && metrics.rttMs > triggers.rtt) return "LOW";
	return "NORMAL";
}

export class SwitcherEngine {
	private state: SwitcherState = "NORMAL";
	private desired: SwitcherState = "NORMAL";
	/** Consecutive polls that wanted `desired` (reset when the target changes). */
	private retryCount = 0;
	private timer: ReturnType<typeof setInterval> | null = null;
	private running = false;
	private active = false;
	private scene: string | null = null;
	private streaming = false;
	private obsConnected = false;
	private updatedAt = 0;

	constructor(
		private config: LowBitrateSwitcherConfig,
		private deps: SwitcherDeps,
	) {}

	get isRunning(): boolean {
		return this.running;
	}

	/** Re-apply config (after modules.configure); keeps the running tick. */
	updateConfig(config: LowBitrateSwitcherConfig): void {
		this.config = config;
	}

	/** Start the poll loop (idempotent; safe to call after a config change). */
	start(): void {
		this.stop();
		this.running = true;
		const intervalMs = Math.max(200, this.config.switcher.pollIntervalMs);
		this.timer = setInterval(() => {
			void this.tick();
		}, intervalMs);
	}

	stop(): void {
		this.running = false;
		if (this.timer) {
			clearInterval(this.timer);
			this.timer = null;
		}
	}

	status(): SwitcherStatus {
		return {
			active: this.active,
			state: this.state,
			desiredState: this.desired,
			retryCount: this.desired !== this.state ? this.retryCount : 0,
			currentScene: this.scene,
			streaming: this.streaming,
			obsConnected: this.obsConnected,
			sources: this.deps.sources(),
			updatedAt: this.updatedAt,
		};
	}

	/** One poll cycle (also called directly in tests). */
	async tick(): Promise<void> {
		if (!this.running) return;
		await this.runPoll();
		this.deps.onUpdate?.();
	}

	private async runPoll(): Promise<void> {
		// Engine master switch off: stay put, refresh the OBS snapshot only.
		if (!this.config.switcher.bitrateSwitcherEnabled) {
			this.sampleObs();
			this.active = false;
			this.resetRetry();
			return;
		}

		const obs = this.sampleObs();
		if (!obs) {
			this.active = false;
			this.resetRetry();
			this.deps.log("error", "the selected obs-controller is unavailable; module idle");
			return;
		}

		if (!obs.connected) {
			if (this.config.obsController.failBehaviour === "pause") {
				this.active = false;
				this.resetRetry();
				return;
			}
			// "ignore": keep evaluating, but scene switches are off the table below.
		} else if (this.config.switcher.onlySwitchWhenStreaming && !obs.streaming) {
			this.active = false;
			this.resetRetry();
			return;
		}

		// The switcher never moves away from the operator's optional scenes.
		const optional = new Set(
			[this.config.optionalScenes.starting, this.config.optionalScenes.ending, this.config.optionalScenes.privacy].filter(
				(s) => s !== "",
			),
		);
		const onOptionalScene = obs.scene !== null && optional.has(obs.scene);

		const metrics = await this.deps.metrics();
		if (metrics === null) {
			this.active = false;
			this.resetRetry();
			this.deps.log("warn", "no active source is available");
			return;
		}
		this.active = true;
		this.updatedAt = this.deps.now();

		// The desired state moved on: the new target's count starts from zero
		const desired = determineState(metrics, this.config);
		if (desired !== this.desired) this.retryCount = 0;
		this.desired = desired;

		if (desired === this.state) {
			this.resetRetry();
			return;
		}

		const scenes = new Set(Object.values(this.config.switcher.switchingScenes));
		const inSwitchingScenes = obs.scene !== null && scenes.has(obs.scene);
		if (onOptionalScene || !inSwitchingScenes) {
			// Scene guard: OBS must sit on a switching scene; no retry buildup.
			this.resetRetry();
			return;
		}
		if (!obs.connected) {
			// failBehaviour "ignore": track the state, never touch the scene.
			this.deps.log("warn", `state ${desired} but obs-controller disconnected; ignoring`);
			return;
		}

		const recover = desired === "NORMAL";
		if (recover && this.config.switcher.instantlySwitchOnRecover) {
			await this.doSwitch();
			return;
		}
		this.retryCount += 1;
		if (this.retryCount >= this.config.switcher.retryAttempts) {
			await this.doSwitch();
		}
	}

	private sampleObs(): ObsSnapshot | null {
		const obs = this.deps.obs();
		if (obs) {
			this.obsConnected = obs.connected;
			this.scene = obs.scene;
			this.streaming = obs.streaming;
		} else {
			this.obsConnected = false;
		}
		return obs;
	}

	private async doSwitch(): Promise<void> {
		const scene = this.config.switcher.switchingScenes[SCENE_FOR_STATE[this.desired]];
		this.retryCount = 0;
		const ok = await this.deps.setScene(scene);
		if (ok) {
			this.state = this.desired;
			this.deps.log("info", `switched to scene "${scene}" (state ${this.state})`);
		} else {
			// Keep counting toward the next attempt on the same target
			this.deps.log("error", `scene switch to "${scene}" failed`);
			this.retryCount = 1;
		}
	}

	private resetRetry(): void {
		this.retryCount = 0;
	}
}

/**
 * Merge a raw config slice (RPC body / persisted settings) with the factory
 * defaults and validate it field by field. Returns the normalized config, or
 * null when the input is not a settings object at all (the caller keeps the
 * module disabled then — an unparseable config must not switch scenes).
 */
export function normalizeSwitcherConfig(raw: unknown): LowBitrateSwitcherConfig | null {
	if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
	const r = raw as Record<string, unknown>;
	const out = structuredClone(defaultLowBitrateSwitcherConfig());

	const asBool = (v: unknown): boolean | undefined => (typeof v === "boolean" ? v : undefined);
	const asNonEmptyString = (v: unknown): string | undefined =>
		typeof v === "string" && v.trim() !== "" ? v : undefined;
	const asInt = (v: unknown, min: number, max: number): number | undefined =>
		typeof v === "number" && Number.isInteger(v) && v >= min && v <= max ? v : undefined;

	const asObject = (v: unknown): Record<string, unknown> | null =>
		v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : null;

	// Sources
	const sources = asObject(r.sources) ?? {};
	for (const key of ["encoder", "relay"] as const) {
		const s = asObject(sources[key]) ?? {};
		const b = asBool(s.enabled);
		if (b !== undefined) out.sources[key].enabled = b;
		const id = asNonEmptyString(s.deviceId);
		if (id) out.sources[key].deviceId = id;
	}
	// OBS controller
	const oc = asObject(r.obsController) ?? {};
	const ocId = asNonEmptyString(oc.moduleId);
	if (ocId) out.obsController.moduleId = ocId;
	if (oc.failBehaviour === "pause" || oc.failBehaviour === "ignore") out.obsController.failBehaviour = oc.failBehaviour;

	// Engine
	const sw = asObject(r.switcher) ?? {};
	const swEnabled = asBool(sw.bitrateSwitcherEnabled);
	if (swEnabled !== undefined) out.switcher.bitrateSwitcherEnabled = swEnabled;
	const oss = asBool(sw.onlySwitchWhenStreaming);
	if (oss !== undefined) out.switcher.onlySwitchWhenStreaming = oss;
	const isr = asBool(sw.instantlySwitchOnRecover);
	if (isr !== undefined) out.switcher.instantlySwitchOnRecover = isr;
	const ra = asInt(sw.retryAttempts, 1, 100);
	if (ra !== undefined) out.switcher.retryAttempts = ra;
	const pi = asInt(sw.pollIntervalMs, 200, 3_600_000);
	if (pi !== undefined) out.switcher.pollIntervalMs = pi;
	const trig = asObject(sw.triggers) ?? {};
	for (const k of ["low", "offline", "rtt"] as const) {
		const v = asInt(trig[k], 0, 100_000_000);
		if (v !== undefined) out.switcher.triggers[k] = v;
	}
	const wc = asObject(sw.switchingScenes) ?? {};
	for (const k of ["normal", "low", "offline"] as const) {
		const s = asNonEmptyString(wc[k]);
		if (s) out.switcher.switchingScenes[k] = s;
	}
	const osc = asObject(r.optionalScenes) ?? {};
	for (const k of ["starting", "ending", "privacy"] as const) {
		const s = asNonEmptyString(osc[k]);
		if (s) out.optionalScenes[k] = s;
	}

	const ltf = asBool(r.logToFile);
	if (ltf !== undefined) out.logToFile = ltf;

	return out;
}
