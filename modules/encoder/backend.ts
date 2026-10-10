/*
 * Encoder module (modules/encoder/backend.ts).
 *
 * Encoder management for encoder / combined devices: pipeline discovery, the
 * `Encoder` base class (start / stop with automatic restart, live bitrate
 * changes) and the concrete encoders:
 *   Belacoder  — bitrate control through a file holding the min and max
 *                bitrate in bit/s (its -b flag)
 *   Ceracoder  — INI config (-c) with balancer tuning
 * Both take the same pipeline / SRT arguments and re-read their bitrate
 * settings on SIGHUP.
 *
 * Pipelines are GStreamer pipeline files under PIPELINES_DIR, including
 * subdirectories (generic/, rk3588/, jetson/, custom/, ...). A pipeline's id
 * is its path relative to that directory, e.g. "rk3588/h265_hdmi_1440p25".
 *
 * Before launch the pipeline is adapted like belaUI does: the ALSA capture
 * card can be swapped or audio dropped, AAC can be replaced by Opus, and the
 * bitrate text overlay is removed unless requested. The result goes to a
 * temp file.
 *
 * Self-contained: wire types are local (./types); the only core edge is the
 * `core` bag handed in at start.
 */
import { readdir, readFile, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join, relative, resolve, sep } from "node:path";
import { z } from "zod";
import {
	BITRATE_KBPS,
	type CeraBalancer,
	type CeraConfig,
	type EncoderConfig,
	type EncoderState,
	type AudioSource,
	type Mctx,
	type Pipeline,
	type EncoderCore,
} from "./types";

/** Core bag, filled at bind (discovery) and re-filled at start (a module may not import the core directly). */
let core: EncoderCore;
/** Resolved pipelines root (deferred: `core` is bound at start, not at import). */
const pipelinesRoot = (): string => resolve(core.config.PIPELINES_DIR);
const RESTART_DELAY_MS = 2_000;
const STOP_TIMEOUT_MS = 5_000;
const PIPELINE_TMP = join(tmpdir(), "srtla_belacoder_pipeline");

// Same patterns belaUI uses to recognise the tweakable parts of a pipeline
const ALSA_SRC = /alsasrc device=[A-Za-z0-9:=]+/;
const ALSA_BRANCH = /alsasrc device=[A-Za-z0-9:]+(.|[\s])*?mux\. *\s?/;
const AAC_ENCODER = /voaacenc\s+bitrate=(\d+)\s+!\s+aacparse\s+!/;
const BITRATE_OVERLAY = /textoverlay[^!]*name=overlay[^!]*!/g;

export const AUDIO_DEFAULT = "default";   // keep the card named in the pipeline
export const AUDIO_NONE = "none";         // strip the audio branch
export const AUDIO_CODECS = ["aac", "opus"] as const;

/** Pipeline files under `dir`, skipping dot entries and directories that cannot be read. */
async function pipelineFiles(dir: string): Promise<string[]> {
    let entries;
    try {
        entries = await readdir(dir, { withFileTypes: true });
    } catch (err: unknown) {
        console.warn(`Cannot read pipelines from ${dir}: ${core.errorMessage(err)}`);
        return [];
    }
    const visible = entries.filter((e) => !e.name.startsWith("."));
    const nested = await Promise.all(visible.filter((e) => e.isDirectory()).map((e) => pipelineFiles(join(dir, e.name))));
    return [...visible.filter((e) => e.isFile()).map((e) => join(dir, e.name)), ...nested.flat()];
}

async function listPipelines(): Promise<Pipeline[]> {
    const root = pipelinesRoot();
    const files = await pipelineFiles(root);
    const list = await Promise.all(files.map(async (file): Promise<Pipeline> => {
        const id = relative(root, file).split(sep).join("/");
        const slash = id.indexOf("/");
        const text = await readFile(file, "utf8").catch(() => "");
        return {
            id,
            group: slash < 0 ? "" : id.slice(0, slash),
            name: id.slice(slash + 1),
            asrc: ALSA_BRANCH.test(text),
            acodec: AAC_ENCODER.test(text),
            overlay: new RegExp(BITRATE_OVERLAY.source).test(text),
        };
    }));
    return list.sort((a, b) => a.group.localeCompare(b.group) || a.name.localeCompare(b.name));
}

// ----------------------------------------------------------------------
// Audio sources (ALSA cards), mirroring belaUI's filtering and ordering
// ----------------------------------------------------------------------
const AUDIO_EXCLUDE = new Set([
    "tegrahda", "tegrasndt210ref", "rockchipdp0", "rockchiphdmi0", "rockchiphdmi1",
    "rockchiphdmi2", "rockchiphdmiind", "rockchipes8316",
]);
const AUDIO_PRIORITY = ["HDMI", "rockchiphdmiin", "rockchipes8388", "C4K", "usbaudio"];
const AUDIO_ALIASES: Record<string, string> = {
    C4K: "Cam Link 4K", usbaudio: "USB audio", rockchiphdmiin: "HDMI", rockchipes8388: "Analog in",
};
const CARD_ID = /^[A-Za-z0-9_-]+$/;

async function listAudioSources(): Promise<AudioSource[]> {
    const dir = "/sys/class/sound";
    const cards = (await readdir(dir).catch(() => [] as string[])).filter((n) => /^card\d+$/.test(n));
    const cardIds = await Promise.all(cards.map((n) => readFile(`${dir}/${n}/id`, "utf8").catch(() => "")));
    const ids = new Set(cardIds.map((id) => id.trim()).filter((id) => id && CARD_ID.test(id) && !AUDIO_EXCLUDE.has(id)));
    const ordered = [
        ...AUDIO_PRIORITY.filter((id) => ids.has(id)),
        ...[...ids].filter((id) => !AUDIO_PRIORITY.includes(id)).sort(),
    ];
    return [
        ...ordered.map((id) => ({ id, name: AUDIO_ALIASES[id] ?? id })),
        { id: AUDIO_DEFAULT, name: "Pipeline default" },
        { id: AUDIO_NONE, name: "No audio" },
    ];
}

/** Write the pipeline with audio / overlay adjustments applied; returns the file to run. */
async function preparePipeline(file: string, cfg: EncoderConfig, write = true): Promise<string> {
    let text = await readFile(file, "utf8");
    if (!text.trim()) throw new Error(`Pipeline is empty: ${relative(pipelinesRoot(), file)}`);
    const source = cfg.audioSource ?? AUDIO_DEFAULT;

    if (source === AUDIO_NONE) {
        text = text.replace(ALSA_BRANCH, "");
    } else if (source !== AUDIO_DEFAULT && ALSA_SRC.test(text)) {
        if (!CARD_ID.test(source)) throw new Error(`Invalid audio source: ${source}`);
        const available = (await listAudioSources()).some((a) => a.id === source);
        if (!available) throw new Error(`Audio source not found: ${source}`);
        text = text.replace(ALSA_SRC, `alsasrc device="hw:${source}"`);
    }

    if (cfg.audioCodec === "opus") {
        text = text.replace(AAC_ENCODER, (_m, br: string) =>
            `audioresample quality=10 sinc-filter-mode=1 ! opusenc bitrate=${br} ! opusparse !`);
    }

    if (!cfg.bitrateOverlay) text = text.replace(BITRATE_OVERLAY, "");

    if (write && !core.config.DRY_RUN) await core.writeFileAtomic(PIPELINE_TMP, text);
    return PIPELINE_TMP;
}

/** Map a pipeline id to its file, refusing anything outside PIPELINES_DIR. */
async function resolvePipeline(id: string): Promise<string> {
    const root = pipelinesRoot();
    const file = resolve(root, id);
    if (!file.startsWith(root + sep)) throw new Error(`Invalid pipeline: ${id}`);
    const info = await stat(file).catch(() => null);
    if (!info?.isFile()) throw new Error(`Unknown pipeline: ${id}`);
    return file;
}

// ----------------------------------------------------------------------
// Encoder base class: process supervision shared by belacoder and ceracoder
// ----------------------------------------------------------------------
// The encoder logs a lot; keep the last line that looks like a problem for the UI
const ERROR_LINE = /error|fail|stall|unable|cannot|could not/i;

abstract class Encoder {
    protected readonly name: string;
    private readonly supervisor = new core.Supervisor("Encoder", RESTART_DELAY_MS, (code) => this.onExit(code));

    constructor(protected readonly bin: string) {
        this.name = basename(bin);
    }

    /** Arguments that point the encoder at its bitrate control file. */
    protected abstract bitrateArgs(): string[];

    /** Write the bitrate control file the encoder reads at start and on SIGHUP. */
    protected abstract writeBitrateControl(minKbps: number, maxKbps: number): Promise<void>;

    /** Write a control file (only printed under --dry-run). */
    protected async writeControlFile(path: string, text: string, preview = `\n${text}`): Promise<void> {
        if (core.config.DRY_RUN) console.log(`[DRY-RUN] write ${path}:${preview}`);
        else await core.writeFileAtomic(path, text);
    }

    /** Make a running encoder re-read its bitrate settings. */
    protected reload(): void {
        const pid = this.supervisor.running ? this.supervisor.pid : undefined;
        if (pid) process.kill(pid, "SIGHUP");
    }

    status(): EncoderState {
        if (this.supervisor.wanted) return core.state.encoder;
        return { running: false, config: core.state.encoder.config, lastError: core.state.encoder.lastError };
    }

    /** Validate pipeline and audio settings without starting anything. */
    async validate(cfg: EncoderConfig): Promise<void> {
        await preparePipeline(await resolvePipeline(cfg.pipeline), cfg, false);
    }

    async start(cfg: EncoderConfig): Promise<EncoderState> {
        if (this.supervisor.wanted) throw new Error("encoder is already running");
        // Keep the complete draft configuration even when validation or process
        // startup fails, so the UI can restore it on the next attempt.
        core.state.encoder = { running: false, config: cfg };
        await core.saveState();
        const pipelineFile = await preparePipeline(await resolvePipeline(cfg.pipeline), cfg);
        await this.writeBitrateControl(cfg.minBitrate ?? BITRATE_KBPS.min, cfg.maxBitrate ?? BITRATE_KBPS.max);

        core.state.encoder = { running: true, config: cfg, startedAt: Date.now(), restarts: 0 };
        if (core.config.DRY_RUN) {
            console.log(`[DRY-RUN] ${this.bin} ${pipelineFile} ${cfg.host} ${cfg.port}`);
            this.supervisor.markWanted();
        } else {
            try {
                await this.supervisor.start(() => this.spawn(cfg, pipelineFile));
            } catch (err: unknown) {
                const msg = `Cannot start ${this.bin}: ${core.errorMessage(err)}`;
                core.state.encoder = { running: false, config: cfg, lastError: msg };
                await core.saveState();
                throw new Error(msg);
            }
        }
        await core.saveState();
        return core.state.encoder;
    }

    async stop(): Promise<void> {
        await this.supervisor.stop(STOP_TIMEOUT_MS);
        core.state.encoder = { running: false, config: core.state.encoder.config };
        await core.saveState();
    }

    /** Change the min / max bitrate; the encoder re-reads its settings on SIGHUP. */
    async setBitrate(minKbps: number, maxKbps: number): Promise<EncoderState> {
        if (core.state.encoder.config) {
            core.state.encoder.config = { ...core.state.encoder.config, minBitrate: minKbps, maxBitrate: maxKbps };
        }
        await this.writeBitrateControl(minKbps, maxKbps);
        this.reload();
        await core.saveState();
        return this.status();
    }

    private spawn(cfg: EncoderConfig, pipelineFile: string): Bun.Subprocess {
        const args = [
            pipelineFile,
            cfg.host,
            cfg.port,
            "-d", String(cfg.delay),
            ...this.bitrateArgs(),
            "-l", String(cfg.latency),
            ...(cfg.streamid ? ["-s", cfg.streamid] : []),
        ];
        console.log(`Starting ${this.bin} ${args.join(" ")}`);
        const proc = Bun.spawn([this.bin, ...args], { stdin: "ignore", stdout: "inherit", stderr: "pipe" });
        core.state.encoder.pid = proc.pid;
        // Surface the noisy stderr in the console and keep the last problem line for the UI
        void this.pumpStderr(proc.stderr).catch(() => {});
        return proc;
    }

    private async pumpStderr(stream: ReadableStream<Uint8Array>): Promise<void> {
        for await (const line of core.readLines(stream)) {
            console.error(`[${this.name}] ${line}`);
            if (ERROR_LINE.test(line) && core.state.encoder.lastError !== line) {
                core.state.encoder.lastError = line;
                core.logEvent("error", "Encoder", line);
                core.notifyStateChange();
            }
        }
    }

    /**
     * The encoder exits on SRT / capture failures; keep retrying like belaUI does.
     * The supervisor re-runs the full start sequence against the same target.
     */
    private onExit(code: number | null): void {
        core.state.encoder.pid = undefined;
        if (!this.supervisor.wanted) return;
        core.logEvent("warn", "Encoder", core.t("log.encoder_exited", code, RESTART_DELAY_MS / 1000));
        core.state.encoder.restarts = (core.state.encoder.restarts ?? 0) + 1;
        core.state.encoder.lastError ??= `${this.name} exited with code ${code}`;
        core.notifyStateChange();
        console.warn(`${this.name} exited with code ${code}; restarting in ${RESTART_DELAY_MS / 1000}s`);
        this.supervisor.scheduleRestart();
    }
}


// ----------------------------------------------------------------------
// Concrete encoders
// ----------------------------------------------------------------------
class Belacoder extends Encoder {
    protected bitrateArgs(): string[] {
        return ["-b", core.config.BITRATE_FILE];
    }

    protected writeBitrateControl(minKbps: number, maxKbps: number): Promise<void> {
        const text = `${minKbps * 1000}\n${maxKbps * 1000}\n`;
        return this.writeControlFile(core.config.BITRATE_FILE, text, ` ${text.replace(/\n/g, " ")}`);
    }
}


// ceracoder (https://github.com/CERALIVE/ceracoder): the Ceracoder encoder and
// its bitrate-control parameters (validation of UI updates, the INI config).
//
// When ENCODER_BIN points at ceracoder instead of belacoder, the encoder takes
// its bitrate settings from a config file (-c) rather than the legacy bitrate
// file (-b), and re-reads it on SIGHUP. Max bitrate and SRT latency live in
// the encoder config (belacoder uses the same values), everything else in the
// persisted ceracoder section.
const CERA_BALANCERS = ["adaptive", "fixed", "aimd"] as const;

const DEFAULT_CERA_CONFIG: CeraConfig = {
	balancer: "adaptive",
	minBitrate: 500,
	adaptive: { incrStep: 30, decrStep: 100, incrInterval: 500, decrInterval: 200 },
	aimd: { incrStep: 50, decrMult: 0.75, incrInterval: 500, decrInterval: 200 },
};

type Range = readonly [min: number, max: number];
const STEP: Range = [1, 10_000];
const INTERVAL: Range = [10, 60_000];
/** Integer bounds per tuning field; `null` marks aimd.decrMult, a fraction in (0, 1). */
const TUNING_RANGES = {
	adaptive: { incrStep: STEP, decrStep: STEP, incrInterval: INTERVAL, decrInterval: INTERVAL },
	aimd: { incrStep: STEP, decrMult: null, incrInterval: INTERVAL, decrInterval: INTERVAL },
} as const;

function intInRange(value: unknown, key: string, [min, max]: Range): number {
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
function mergeCeraConfig(current: CeraConfig, partial: unknown): CeraConfig {
	const p = (partial && typeof partial === "object" ? partial : {}) as Record<string, unknown>;
	if (p.balancer != null && !CERA_BALANCERS.includes(p.balancer as CeraBalancer)) {
		throw new Error(`Invalid balancer: ${String(p.balancer)}`);
	}
	const merged: CeraConfig = {
		balancer: (p.balancer as CeraBalancer | undefined) ?? current.balancer,
		minBitrate: p.minBitrate == null
			? current.minBitrate
			: intInRange(p.minBitrate, "minBitrate", [BITRATE_KBPS.min, BITRATE_KBPS.max]),
		adaptive: { ...current.adaptive },
		aimd: { ...current.aimd },
	};

	for (const group of ["adaptive", "aimd"] as const) {
		const update = p[group];
		if (update == null) continue;
		if (typeof update !== "object") throw new Error(`${group} must be an object`);
		const target = merged[group] as unknown as Record<string, number>;
		for (const [key, range] of Object.entries(TUNING_RANGES[group])) {
			const value = (update as Record<string, unknown>)[key];
			const name = `${group}.${key}`;
			if (range) {
				if (value !== undefined) target[key] = intInRange(value, name, range);
				continue;
			}
			const n = value === undefined ? target[key] : Number(value);
			if (!Number.isFinite(n) || n <= 0 || n >= 1) {
				throw new Error(`${name} must be a number between 0 and 1 (exclusive)`);
			}
			target[key] = n;
		}
	}
	return merged;
}

/** Render the INI config as ceracoder's -c flag consumes it. */
function ceraConfText(cfg: CeraConfig, maxBitrate: number, latency: number): string {
	const section = (name: string, values: Record<string, number | string>) =>
		[`[${name}]`, ...Object.entries(values).map(([k, v]) => `${k} = ${v}`), ""];
	// Fixed key order (the persisted config sorts keys alphabetically)
	const tuning = (group: "adaptive" | "aimd") =>
		Object.fromEntries(Object.keys(TUNING_RANGES[group]).map((k) => [
			k.replace(/[A-Z]/g, (c) => `_${c.toLowerCase()}`),
			(cfg[group] as unknown as Record<string, number>)[k],
		]));
	return [
		"# Generated by belabox-duo — do not hand-edit (use the control UI)",
		"",
		...section("general", { min_bitrate: cfg.minBitrate, max_bitrate: maxBitrate, balancer: cfg.balancer }),
		...section("srt", { latency }),
		...section("adaptive", tuning("adaptive")),
		...section("aimd", tuning("aimd")),
	].join("\n");
}

class Ceracoder extends Encoder {
	/** Bitrate-control settings as persisted in the device state (defaults applied). */
	config(): CeraConfig {
		return core.state.ceracoder ?? DEFAULT_CERA_CONFIG;
	}

	/** Validate and persist a partial settings update, rewrite the INI and reload a running encoder. */
	async update(partial: unknown): Promise<CeraConfig> {
		const next = mergeCeraConfig(this.config(), partial);
		core.state.ceracoder = next;
		await this.writeBitrateControl(next.minBitrate, core.state.encoder.config?.maxBitrate ?? 5000);
		this.reload();
		await core.saveState();
		return next;
	}

	override setBitrate(minKbps: number, maxKbps: number) {
		// The INI reads the min from the persisted ceracoder section; keep it in sync
		core.state.ceracoder = { ...this.config(), minBitrate: minKbps };
		return super.setBitrate(minKbps, maxKbps);
	}

	protected bitrateArgs(): string[] {
		return ["-c", core.config.CERACODER_CONF];
	}

	/** The min comes from the ceracoder section, the latency from the encoder config. */
	protected writeBitrateControl(_minKbps: number, maxKbps: number): Promise<void> {
		const latency = core.state.encoder.config?.latency ?? 2000;
		return this.writeControlFile(core.config.CERACODER_CONF, ceraConfText(this.config(), maxKbps, latency));
	}
}


// ----------------------------------------------------------------------
// Module entry
// ----------------------------------------------------------------------
let instance: Encoder | null = null;

/**
 * The device's encoder (see loadEncoder()); created lazily so the first
 * access — from a method, the status build, or stream orchestration — works
 * without a separate startup call. The core bag is bound at module
 * discovery, so construction works even when the module is disabled
 * (the instance simply reports a stopped state).
 */
function encoder(): Encoder {
	if (!instance) instance = core.config.IS_CERA ? new Ceracoder(core.config.ENCODER_BIN) : new Belacoder(core.config.ENCODER_BIN);
	return instance;
}

/** Create the device's encoder (idempotent; kept as a capability for the shutdown path). */
function loadEncoder(): Encoder {
	return encoder();
}

const encoderServices = {
	loadEncoder,
	encoder,
	listPipelines,
	listAudioSources,
	AUDIO_CODECS,
	AUDIO_DEFAULT,
	AUDIO_NONE,
	isCera: (enc: Encoder): boolean => enc instanceof Ceracoder,
	/** Persisted ceracoder settings, or null when the encoder is not ceracoder. */
	ceracoderConfig: (): CeraConfig | null => {
		const enc = encoder();
		return enc instanceof Ceracoder ? enc.config() : null;
	},
};

const methods = ["encoder.status", "encoder.start", "encoder.stop", "encoder.bitrate", "ceracoder.set"] as const;

export default {
	kind: "device",
	id: "encoder",
	title: "Encoder",
	configSchema: z.object({}).passthrough(),
	secretFields: [] as string[],
	bind(c: EncoderCore) {
		core = c;
	},
	async start(_ctx: Mctx) {
		core = _ctx.core;
	},
	async stop() {
		await encoder().stop();
	},
	methods,
	events: [] as string[],
	async dispatch(method: string, params: Record<string, unknown>) {
		switch (method) {
			case "encoder.status":
				return encoder().status();
			case "encoder.start":
				await encoder().start(params as unknown as EncoderConfig);
				return encoder().status();
			case "encoder.stop":
				await encoder().stop();
				return encoder().status();
			case "encoder.bitrate":
				return encoder().setBitrate(Number(params["minBitrate"]), Number(params["maxBitrate"]));
			case "ceracoder.set": {
				const enc = encoder();
				if (!(enc instanceof Ceracoder)) throw new Error("The device encoder is not ceracoder");
				return enc.update(params);
			}
			default:
				throw new Error(`unknown method ${method}`);
		}
	},
	async status() {
		const enc = encoder();
		return { ceracoder: enc instanceof Ceracoder ? enc.config() : null };
	},
	services: {
		capabilities: {
			"stream.encoder": encoderServices,
		},
	},
};
