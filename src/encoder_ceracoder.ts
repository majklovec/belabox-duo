/*
 * ceracoder-specific encoder pieces: the bitrate-control parameters, the INI
 * config, live reload and process start. The common pipeline handling and
 * process supervision live in encoder.ts; belacoder's bitrate file lives in
 * encoder_belacoder.ts.
 *
 * ceracoder bitrate-control parameters (https://github.com/CERALIVE/ceracoder).
 *
 * When ENCODER_BIN points at ceracoder instead of belacoder, the encoder takes
 * its bitrate settings from a config file (-c) rather than the legacy bitrate
 * file (-b), and re-reads it on SIGHUP:
 *
 *   [general]
 *   min_bitrate = 500     # Kbps
 *   max_bitrate = 6000    # Kbps
 *   balancer = adaptive   # adaptive | fixed | aimd
 *
 *   [srt]
 *   latency = 2000        # ms
 *
 *   [adaptive]  incr_step / decr_step (Kbps), incr_interval / decr_interval (ms)
 *   [aimd]      incr_step (Kbps), decr_mult (0-1), incr_interval / decr_interval (ms)
 *
 * Max bitrate and SRT latency live in the encoder config (belacoder uses the
 * same values), everything else in the persisted `ceracoder` section.
 */
import { CERACODER_CONF, DRY_RUN, ENCODER_BIN } from "./config";
import { saveState, state } from "./state";
import { type EncoderConfig, pumpStderr, signalEncoderReload } from "./encoder";

export const CERA_BALANCERS = ["adaptive", "fixed", "aimd"] as const;
export type CeraBalancer = (typeof CERA_BALANCERS)[number];

/** Tuning of the adaptive (default) balancer. */
export interface AdaptiveTuning {
	incrStep: number;      // Kbps
	decrStep: number;      // Kbps
	incrInterval: number;  // ms
	decrInterval: number;  // ms
}

/** Tuning of the AIMD balancer. */
export interface AimdTuning {
	incrStep: number;      // Kbps
	decrMult: number;      // fraction of the bitrate kept on congestion (0-1)
	incrInterval: number;  // ms
	decrInterval: number;  // ms
}

/** ceracoder parameters persisted in the device config (`ceracoder` section). */
export interface CeraConfig {
	balancer: CeraBalancer;
	minBitrate: number;    // Kbps
	adaptive: AdaptiveTuning;
	aimd: AimdTuning;
}

// Same bounds the encoder enforces for belacoder's bitrate file (Kbps).
export const CERA_MIN_BITRATE = 300;
export const CERA_MAX_BITRATE = 30_000;

export const DEFAULT_CERA_CONFIG: CeraConfig = {
	balancer: "adaptive",
	minBitrate: 500,
	adaptive: { incrStep: 30, decrStep: 100, incrInterval: 500, decrInterval: 200 },
	aimd: { incrStep: 50, decrMult: 0.75, incrInterval: 500, decrInterval: 200 },
};

function intInRange(value: unknown, key: string, min: number, max: number): number {
	const n = Number(value);
	if (!Number.isInteger(n) || n < min || n > max) {
		throw new Error(`${key} must be an integer between ${min} and ${max}`);
	}
	return n;
}

/**
 * Validate and merge a partial update (as sent by the UI) over the current
 * settings; returns the complete new config. Throws on invalid values.
 */
export function mergeCeraConfig(current: CeraConfig, partial: unknown): CeraConfig {
	const p = (partial && typeof partial === "object" ? partial : {}) as Record<string, unknown>;
	if (p.balancer !== undefined && p.balancer !== null && !CERA_BALANCERS.includes(p.balancer as CeraBalancer)) {
		throw new Error("Invalid balancer: " + String(p.balancer));
	}
	const merged: CeraConfig = {
		balancer: typeof p.balancer === "string" ? (p.balancer as CeraBalancer) : current.balancer,
		minBitrate: p.minBitrate === undefined || p.minBitrate === null
			? current.minBitrate
			: intInRange(p.minBitrate, "minBitrate", CERA_MIN_BITRATE, CERA_MAX_BITRATE),
		adaptive: { ...current.adaptive },
		aimd: { ...current.aimd },
	};
	if (!CERA_BALANCERS.includes(merged.balancer as CeraBalancer)) {
		throw new Error(`balancer must be one of ${CERA_BALANCERS.join(", ")}`);
	}

	const tune = <T extends object>(value: unknown, key: string): Partial<T> | null => {
		if (value === undefined || value === null) return null;
		if (typeof value !== "object") throw new Error(`${key} must be an object`);
		return value as Partial<T>;
	};

	const a = tune<AdaptiveTuning>(p.adaptive, "adaptive");
	if (a) {
		merged.adaptive.incrStep = a.incrStep === undefined ? merged.adaptive.incrStep
			: intInRange(a.incrStep, "adaptive.incrStep", 1, 10_000);
		merged.adaptive.decrStep = a.decrStep === undefined ? merged.adaptive.decrStep
			: intInRange(a.decrStep, "adaptive.decrStep", 1, 10_000);
		merged.adaptive.incrInterval = a.incrInterval === undefined ? merged.adaptive.incrInterval
			: intInRange(a.incrInterval, "adaptive.incrInterval", 10, 60_000);
		merged.adaptive.decrInterval = a.decrInterval === undefined ? merged.adaptive.decrInterval
			: intInRange(a.decrInterval, "adaptive.decrInterval", 10, 60_000);
	}

	const i = tune<AimdTuning>(p.aimd, "aimd");
	if (i) {
		merged.aimd.incrStep = i.incrStep === undefined ? merged.aimd.incrStep
			: intInRange(i.incrStep, "aimd.incrStep", 1, 10_000);
		merged.aimd.decrMult = i.decrMult === undefined ? merged.aimd.decrMult
			: Number(i.decrMult);
		if (!Number.isFinite(merged.aimd.decrMult) || merged.aimd.decrMult <= 0 || merged.aimd.decrMult >= 1) {
			throw new Error("aimd.decrMult must be a number between 0 and 1 (exclusive)");
		}
		merged.aimd.incrInterval = i.incrInterval === undefined ? merged.aimd.incrInterval
			: intInRange(i.incrInterval, "aimd.incrInterval", 10, 60_000);
		merged.aimd.decrInterval = i.decrInterval === undefined ? merged.aimd.decrInterval
			: intInRange(i.decrInterval, "aimd.decrInterval", 10, 60_000);
	}
	return merged;
}

/** Render the INI config as ceracoder's -c flag consumes it. */
export function ceraConfText(cfg: CeraConfig, maxBitrate: number, latency: number): string {
	return [
		"# Generated by belabox-duo — do not hand-edit (use the control UI)",
		"",
		"[general]",
		`min_bitrate = ${cfg.minBitrate}`,
		`max_bitrate = ${maxBitrate}`,
		`balancer = ${cfg.balancer}`,
		"",
		"[srt]",
		`latency = ${latency}`,
		"",
		"[adaptive]",
		`incr_step = ${cfg.adaptive.incrStep}`,
		`decr_step = ${cfg.adaptive.decrStep}`,
		`incr_interval = ${cfg.adaptive.incrInterval}`,
		`decr_interval = ${cfg.adaptive.decrInterval}`,
		"",
		"[aimd]",
		`incr_step = ${cfg.aimd.incrStep}`,
		`decr_mult = ${cfg.aimd.decrMult}`,
		`incr_interval = ${cfg.aimd.incrInterval}`,
		`decr_interval = ${cfg.aimd.decrInterval}`,
		"",
	].join("\n");
}

/** ceracoder's config as persisted in the device state (defaults applied). */
export function currentCeraConfig(): CeraConfig {
	return state.ceracoder ?? DEFAULT_CERA_CONFIG;
}

/** Write ceracoder's INI config, taking max bitrate / latency from the encoder config. */
export async function writeCeraConf(): Promise<void> {
	const enc = state.encoder.config;
	const text = ceraConfText(currentCeraConfig(), enc?.maxBitrate ?? 5000, enc?.latency ?? 2000);
	if (DRY_RUN) {
		console.log(`[DRY-RUN] write ${CERACODER_CONF}:\n${text}`);
		return;
	}
	await Bun.write(CERACODER_CONF, text);
}

/** Persist ceracoder settings, rewrite the INI and reload it if the encoder is running. */
export async function updateCeraConfig(next: CeraConfig): Promise<CeraConfig> {
	state.ceracoder = next;
	await writeCeraConf();
	signalEncoderReload();
	await saveState();
	return next;
}

export function spawnCeracoder(cfg: EncoderConfig, pipelineFile: string): Bun.Subprocess {
	const args = [
		pipelineFile,
		cfg.host,
		cfg.port,
		"-d", String(cfg.delay),
		"-c", CERACODER_CONF,
		"-l", String(cfg.latency),
	];
	if (cfg.streamid) args.push("-s", cfg.streamid);
	console.log(`Starting ${ENCODER_BIN} ${args.join(" ")}`);

	const p = Bun.spawn([ENCODER_BIN, ...args], { stdin: "ignore", stdout: "inherit", stderr: "pipe" });
	state.encoder.pid = p.pid;

	// Surface the noisy stderr in the console and keep the last problem line for the UI.
	void pumpStderr(p.stderr).catch(() => {});
	return p;
}
