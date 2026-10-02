/*
 * Encoder management for encoder / combined devices: pipeline discovery and the
 * `Encoder` base class (start / stop with automatic restart, live bitrate changes).
 *
 * The concrete encoder is chosen by ENCODER_BIN (see encoder()):
 *   belacoder.ts  Belacoder — bitrate file (-b, min / max in bit/s)
 *   ceracoder.ts  Ceracoder — INI config (-c) with balancer tuning
 * Both take the same pipeline / SRT arguments and re-read their bitrate settings on SIGHUP.
 *
 * Pipelines are GStreamer pipeline files under PIPELINES_DIR, including
 * subdirectories (generic/, rk3588/, jetson/, custom/, ...). A pipeline's id
 * is its path relative to that directory, e.g. "rk3588/h265_hdmi_1440p25".
 *
 * Before launch the pipeline is adapted like belaUI does: the ALSA capture card
 * can be swapped or audio dropped, AAC can be replaced by Opus, and the bitrate
 * text overlay is removed unless requested. The result goes to a temp file.
 */
import { readdir, readFile, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join, relative, resolve, sep } from "node:path";
import { DRY_RUN, ENCODER_BIN, IS_CERA, PIPELINES_DIR } from "./config";
import { logEvent } from "./eventlog";
import { writeFileAtomic } from "./files";
import { t } from "./i18n";
import { notifyStateChange, saveState, state } from "./state";
import { Supervisor } from "./supervisor";
import { errorMessage, readLines } from "./util";
import { BITRATE_KBPS } from "./validate";

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
export type AudioCodec = (typeof AUDIO_CODECS)[number];

export interface Pipeline {
    id: string;       // path relative to PIPELINES_DIR
    group: string;    // first directory component ("" for top-level files)
    name: string;     // file name
    asrc: boolean;    // captures from an ALSA card (source can be changed / removed)
    acodec: boolean;  // encodes AAC (can be switched to Opus)
    overlay: boolean; // has the bitrate text overlay
}

export interface AudioSource { id: string; name: string; }

export interface EncoderConfig {
    pipeline: string;
    host: string;         // SRT destination (the relay, or 127.0.0.1 when combined)
    port: string;
    minBitrate: number;   // kbps
    maxBitrate: number;   // kbps
    latency: number;      // SRT latency, ms
    delay: number;        // audio delay, ms
    streamid?: string;
    audioSource?: string; // ALSA card id, AUDIO_DEFAULT or AUDIO_NONE
    audioCodec?: AudioCodec;
    bitrateOverlay?: boolean;
}

export interface EncoderState {
    running: boolean;
    pid?: number;
    config?: EncoderConfig;   // last used; kept after stop so the UI can prefill
    startedAt?: number;
    restarts?: number;
    lastError?: string;
}

const pipelinesRoot = resolve(PIPELINES_DIR);

/** Pipeline files under `dir`, skipping dot entries and directories that cannot be read. */
async function pipelineFiles(dir: string): Promise<string[]> {
    let entries;
    try {
        entries = await readdir(dir, { withFileTypes: true });
    } catch (err: unknown) {
        console.warn(`Cannot read pipelines from ${dir}: ${errorMessage(err)}`);
        return [];
    }
    const visible = entries.filter((e) => !e.name.startsWith("."));
    const nested = await Promise.all(visible.filter((e) => e.isDirectory()).map((e) => pipelineFiles(join(dir, e.name))));
    return [...visible.filter((e) => e.isFile()).map((e) => join(dir, e.name)), ...nested.flat()];
}

export async function listPipelines(): Promise<Pipeline[]> {
    const files = await pipelineFiles(pipelinesRoot);
    const list = await Promise.all(files.map(async (file): Promise<Pipeline> => {
        const id = relative(pipelinesRoot, file).split(sep).join("/");
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

export async function listAudioSources(): Promise<AudioSource[]> {
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
    if (!text.trim()) throw new Error(`Pipeline is empty: ${relative(pipelinesRoot, file)}`);
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

    if (write && !DRY_RUN) await writeFileAtomic(PIPELINE_TMP, text);
    return PIPELINE_TMP;
}

/** Map a pipeline id to its file, refusing anything outside PIPELINES_DIR. */
async function resolvePipeline(id: string): Promise<string> {
    const file = resolve(pipelinesRoot, id);
    if (!file.startsWith(pipelinesRoot + sep)) throw new Error(`Invalid pipeline: ${id}`);
    const info = await stat(file).catch(() => null);
    if (!info?.isFile()) throw new Error(`Unknown pipeline: ${id}`);
    return file;
}

// ----------------------------------------------------------------------
// Encoder base class: process supervision shared by belacoder and ceracoder
// ----------------------------------------------------------------------
// The encoder logs a lot; keep the last line that looks like a problem for the UI
const ERROR_LINE = /error|fail|stall|unable|cannot|could not/i;

export abstract class Encoder {
    protected readonly name: string;
    private readonly supervisor = new Supervisor("Encoder", RESTART_DELAY_MS, (code) => this.onExit(code));

    constructor(protected readonly bin: string) {
        this.name = basename(bin);
    }

    /** Arguments that point the encoder at its bitrate control file. */
    protected abstract bitrateArgs(): string[];

    /** Write the bitrate control file the encoder reads at start and on SIGHUP. */
    protected abstract writeBitrateControl(minKbps: number, maxKbps: number): Promise<void>;

    /** Write a control file (only printed under --dry-run). */
    protected async writeControlFile(path: string, text: string, preview = `\n${text}`): Promise<void> {
        if (DRY_RUN) console.log(`[DRY-RUN] write ${path}:${preview}`);
        else await writeFileAtomic(path, text);
    }

    /** Make a running encoder re-read its bitrate settings. */
    protected reload(): void {
        const pid = this.supervisor.running ? this.supervisor.pid : undefined;
        if (pid) process.kill(pid, "SIGHUP");
    }

    status(): EncoderState {
        if (this.supervisor.wanted) return state.encoder;
        return { running: false, config: state.encoder.config, lastError: state.encoder.lastError };
    }

    /** Validate pipeline and audio settings without starting anything. */
    async validate(cfg: EncoderConfig): Promise<void> {
        await preparePipeline(await resolvePipeline(cfg.pipeline), cfg, false);
    }

    async start(cfg: EncoderConfig): Promise<EncoderState> {
        if (this.supervisor.wanted) throw new Error("encoder is already running");
        // Keep the complete draft configuration even when validation or process
        // startup fails, so the UI can restore it on the next attempt.
        state.encoder = { running: false, config: cfg };
        await saveState();
        const pipelineFile = await preparePipeline(await resolvePipeline(cfg.pipeline), cfg);
        await this.writeBitrateControl(cfg.minBitrate ?? BITRATE_KBPS.min, cfg.maxBitrate);

        state.encoder = { running: true, config: cfg, startedAt: Date.now(), restarts: 0 };
        if (DRY_RUN) {
            console.log(`[DRY-RUN] ${this.bin} ${pipelineFile} ${cfg.host} ${cfg.port}`);
            this.supervisor.markWanted();
        } else {
            try {
                await this.supervisor.start(() => this.spawn(cfg, pipelineFile));
            } catch (err: unknown) {
                const msg = `Cannot start ${this.bin}: ${errorMessage(err)}`;
                state.encoder = { running: false, config: cfg, lastError: msg };
                await saveState();
                throw new Error(msg);
            }
        }
        await saveState();
        return state.encoder;
    }

    async stop(): Promise<void> {
        await this.supervisor.stop(STOP_TIMEOUT_MS);
        state.encoder = { running: false, config: state.encoder.config };
        await saveState();
    }

    /** Change the min / max bitrate; the encoder re-reads its settings on SIGHUP. */
    async setBitrate(minKbps: number, maxKbps: number): Promise<EncoderState> {
        if (state.encoder.config) {
            state.encoder.config = { ...state.encoder.config, minBitrate: minKbps, maxBitrate: maxKbps };
        }
        await this.writeBitrateControl(minKbps, maxKbps);
        this.reload();
        await saveState();
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
        state.encoder.pid = proc.pid;
        // Surface the noisy stderr in the console and keep the last problem line for the UI
        void this.pumpStderr(proc.stderr).catch(() => {});
        return proc;
    }

    private async pumpStderr(stream: ReadableStream<Uint8Array>): Promise<void> {
        for await (const line of readLines(stream)) {
            console.error(`[${this.name}] ${line}`);
            if (ERROR_LINE.test(line) && state.encoder.lastError !== line) {
                state.encoder.lastError = line;
                logEvent("error", "Encoder", line);
                notifyStateChange();
            }
        }
    }

    /**
     * The encoder exits on SRT / capture failures; keep retrying like belaUI does.
     * The supervisor re-runs the full start sequence against the same target.
     */
    private onExit(code: number | null): void {
        state.encoder.pid = undefined;
        if (!this.supervisor.wanted) return;
        logEvent("warn", "Encoder", t("log.encoder_exited", code, RESTART_DELAY_MS / 1000));
        state.encoder.restarts = (state.encoder.restarts ?? 0) + 1;
        state.encoder.lastError ??= `${this.name} exited with code ${code}`;
        notifyStateChange();
        console.warn(`${this.name} exited with code ${code}; restarting in ${RESTART_DELAY_MS / 1000}s`);
        this.supervisor.scheduleRestart();
    }
}

let instance: Encoder | null = null;

/**
 * Create the device's encoder: Ceracoder when ENCODER_BIN is ceracoder, else Belacoder.
 * Called once at startup (client.ts). The subclasses import this module for the base
 * class, so they are imported dynamically here: a static import cycle would run
 * `class … extends Encoder` before Encoder exists.
 */
export async function loadEncoder(): Promise<Encoder> {
    instance ??= IS_CERA
        ? new (await import("./encoders/ceracoder")).Ceracoder(ENCODER_BIN)
        : new (await import("./encoders/belacoder")).Belacoder(ENCODER_BIN);
    return instance;
}

/** The device's encoder (see loadEncoder()). */
export function encoder(): Encoder {
    if (!instance) throw new Error("encoder not loaded yet (call loadEncoder() at startup)");
    return instance;
}
