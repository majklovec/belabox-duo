/**
 * The low-bitrate switcher engine — the pure state machine of the
 * low-bitrate-switcher module: decides NORMAL / LOW / OFFLINE from metrics,
 * accumulates retry counts, and drives scene switches. No device wiring here
 * (no OBS, no sources, no disk): everything comes through `SwitcherDeps`, so
 * the whole behaviour is unit-testable.
 */
import type {
	SwitcherActiveSources,
	SwitcherConfig,
	SwitcherMetrics,
	SwitcherState,
	SwitcherStatus,
} from "../../public/types";

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
export function determineState(metrics: SwitcherMetrics, config: SwitcherConfig): SwitcherState {
	if (!config.autoSwitch) return "NORMAL";
	if (metrics.connected === false) return "OFFLINE";
	if (metrics.bitrateKbps !== null && metrics.bitrateKbps < config.triggers.offline) return "OFFLINE";
	if (metrics.bitrateKbps !== null && metrics.bitrateKbps < config.triggers.low) return "LOW";
	if (metrics.rttMs !== null && metrics.rttMs > config.triggers.rtt) return "LOW";
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
		private config: SwitcherConfig,
		private deps: SwitcherDeps,
	) {}

	get isRunning(): boolean {
		return this.running;
	}

	/** Re-apply config (after `lowBitrateSwitcher.save`); keeps the running tick. */
	updateConfig(config: SwitcherConfig): void {
		this.config = config;
	}

	/** Start the poll loop (idempotent; safe to call after a config change). */
	start(): void {
		this.stop();
		this.running = true;
		const intervalMs = Math.max(200, this.config.pollIntervalMs);
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
		if (!this.config.autoSwitch) {
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
			if (this.config.failBehaviour === "pause") {
				this.active = false;
				this.resetRetry();
				return;
			}
			// "ignore": keep evaluating, but scene switches are off the table below.
		} else if (this.config.onlySwitchWhenStreaming && !obs.streaming) {
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

		const scenes = new Set(Object.values(this.config.scenes));
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
		if (recover && this.config.instantlySwitchOnRecover) {
			await this.doSwitch();
			return;
		}
		this.retryCount += 1;
		if (this.retryCount >= this.config.retryAttempts) {
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
		const scene = this.config.scenes[SCENE_FOR_STATE[this.desired]];
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

