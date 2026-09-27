/*
 * belacoder management for encoder / combined devices: pipeline discovery,
 * start / stop with automatic restart, and live bitrate changes.
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
import { join, relative, resolve, sep } from "node:path";
import { BELACODER_BIN, BITRATE_FILE, DRY_RUN, PIPELINES_DIR } from "./config";
import { notifyStateChange, saveState, state } from "./state";

export const MIN_BITRATE_KBPS = 300;
export const MAX_BITRATE_KBPS = 30_000;
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

export async function listPipelines(): Promise<Pipeline[]> {
    let entries;
    try {
        entries = await readdir(pipelinesRoot, { recursive: true, withFileTypes: true });
    } catch (err: unknown) {
        console.warn(`Cannot read pipelines from ${pipelinesRoot}: ${err instanceof Error ? err.message : String(err)}`);
        return [];
    }
    const files = entries
        .filter((e) => e.isFile() && !e.name.startsWith("."))
        .map((e) => resolve(e.parentPath, e.name))
        .filter((f) => !relative(pipelinesRoot, f).split(sep).some((part) => part.startsWith(".")));

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
    const names = await readdir(dir).catch(() => [] as string[]);
    const ids = new Set<string>();
    for (const n of names.filter((n) => /^card\d+$/.test(n))) {
        const id = (await readFile(`${dir}/${n}/id`, "utf8").catch(() => "")).trim();
        if (id && CARD_ID.test(id) && !AUDIO_EXCLUDE.has(id)) ids.add(id);
    }
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

    if (write && !DRY_RUN) await Bun.write(PIPELINE_TMP, text);
    return PIPELINE_TMP;
}

/** Validate pipeline and audio settings without starting anything. */
export async function validateEncoderConfig(cfg: EncoderConfig): Promise<void> {
    await preparePipeline(await resolvePipeline(cfg.pipeline), cfg, false);
}

/** Map a pipeline id to its file, refusing anything outside PIPELINES_DIR. */
export async function resolvePipeline(id: string): Promise<string> {
    const file = resolve(pipelinesRoot, id);
    if (!file.startsWith(pipelinesRoot + sep)) throw new Error(`Invalid pipeline: ${id}`);
    const info = await stat(file).catch(() => null);
    if (!info?.isFile()) throw new Error(`Unknown pipeline: ${id}`);
    return file;
}

// ----------------------------------------------------------------------
// Process management
// ----------------------------------------------------------------------
let proc: Bun.Subprocess<"ignore", "inherit", "pipe"> | null = null;
let wanted = false;
let restartTimer: ReturnType<typeof setTimeout> | null = null;

export function encoderStatus(): EncoderState {
    if (wanted) return state.encoder;
    return { running: false, config: state.encoder.config, lastError: state.encoder.lastError };
}

async function writeBitrateFile(kbps: number): Promise<void> {
    const content = `${MIN_BITRATE_KBPS * 1000}\n${kbps * 1000}\n`;
    if (DRY_RUN) {
        console.log(`[DRY-RUN] write ${BITRATE_FILE}: ${content.replace(/\n/g, " ")}`);
        return;
    }
    await Bun.write(BITRATE_FILE, content);
}

// belacoder logs a lot; keep the last line that looks like a problem for the UI
const ERROR_LINE = /error|fail|stall|unable|cannot|could not/i;

async function pumpStderr(stream: ReadableStream<Uint8Array>): Promise<void> {
    const decoder = new TextDecoder();
    let buffer = "";
    for await (const chunk of stream) {
        buffer += decoder.decode(chunk, { stream: true });
        let nl: number;
        while ((nl = buffer.indexOf("\n")) !== -1) {
            const line = buffer.slice(0, nl).trim();
            buffer = buffer.slice(nl + 1);
            if (!line) continue;
            console.error(`[belacoder] ${line}`);
            if (ERROR_LINE.test(line) && state.encoder.lastError !== line) {
                state.encoder.lastError = line;
                notifyStateChange();
            }
        }
    }
}

function spawnBelacoder(cfg: EncoderConfig, pipelineFile: string): void {
    const args = [
        pipelineFile, cfg.host, cfg.port,
        "-d", String(cfg.delay),
        "-b", BITRATE_FILE,
        "-l", String(cfg.latency),
    ];
    if (cfg.streamid) args.push("-s", cfg.streamid);
    console.log(`Starting ${BELACODER_BIN} ${args.join(" ")}`);

    const p = Bun.spawn([BELACODER_BIN, ...args], { stdin: "ignore", stdout: "inherit", stderr: "pipe" });
    proc = p;
    state.encoder.pid = p.pid;
    void pumpStderr(p.stderr).catch(() => {});

    p.exited.then((code) => {
        if (proc !== p) return;
        proc = null;
        state.encoder.pid = undefined;
        if (!wanted) return;
        // belacoder exits on SRT / capture failures; keep retrying like belaUI does
        console.warn(`belacoder exited with code ${code}; restarting in ${RESTART_DELAY_MS / 1000}s`);
        state.encoder.restarts = (state.encoder.restarts ?? 0) + 1;
        state.encoder.lastError ??= `belacoder exited with code ${code}`;
        notifyStateChange();
        scheduleRestart(cfg, pipelineFile);
    });
}

function scheduleRestart(cfg: EncoderConfig, pipelineFile: string): void {
    restartTimer = setTimeout(() => {
        restartTimer = null;
        if (!wanted) return;
        try {
            spawnBelacoder(cfg, pipelineFile);
            notifyStateChange();
        } catch (err: unknown) {
            console.error("belacoder restart failed:", err instanceof Error ? err.message : String(err));
            scheduleRestart(cfg, pipelineFile);
        }
    }, RESTART_DELAY_MS);
}

export async function startEncoder(cfg: EncoderConfig): Promise<EncoderState> {
    if (wanted) throw new Error("encoder is already running");
    const pipelineFile = await preparePipeline(await resolvePipeline(cfg.pipeline), cfg);
    await writeBitrateFile(cfg.maxBitrate);

    state.encoder = { running: true, config: cfg, startedAt: Date.now(), restarts: 0 };
    if (DRY_RUN) {
        console.log(`[DRY-RUN] ${BELACODER_BIN} ${pipelineFile} ${cfg.host} ${cfg.port}`);
    } else {
        try {
            spawnBelacoder(cfg, pipelineFile);
        } catch (err: unknown) {
            const msg = `Cannot start ${BELACODER_BIN}: ${err instanceof Error ? err.message : String(err)}`;
            state.encoder = { running: false, config: cfg, lastError: msg };
            await saveState();
            throw new Error(msg);
        }
    }
    wanted = true;
    await saveState();
    return state.encoder;
}

export async function stopEncoder(): Promise<void> {
    wanted = false;
    if (restartTimer) clearTimeout(restartTimer);
    restartTimer = null;
    const p = proc;
    if (p && p.exitCode === null) {
        p.kill("SIGTERM");
        const killer = setTimeout(() => p.kill("SIGKILL"), STOP_TIMEOUT_MS);
        await p.exited;
        clearTimeout(killer);
    }
    proc = null;
    state.encoder = { running: false, config: state.encoder.config };
    await saveState();
}

/** Change the max bitrate; belacoder re-reads the bitrate file on SIGHUP. */
export async function setEncoderBitrate(kbps: number): Promise<EncoderState> {
    await writeBitrateFile(kbps);
    if (state.encoder.config) state.encoder.config = { ...state.encoder.config, maxBitrate: kbps };
    if (proc && proc.exitCode === null) proc.kill("SIGHUP");
    await saveState();
    return encoderStatus();
}
