/*
 * Common encoder management for encoder / combined devices: pipeline
 * discovery, start / stop with automatic restart, and live bitrate changes.
 *
 * The encoder binary is belacoder by default. Both take the same arguments except
 * for bitrate control: belacoder reads a bitrate file (-b, min / max in bit/s),
 * ceracoder (IS_CERA) an INI config (-c, see ceracoder.ts). Both re-read it on SIGHUP.
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
import { type CeraConfig, ceraConfText, DEFAULT_CERA_CONFIG } from "./ceracoder";
import { BITRATE_FILE, CERACODER_CONF, DRY_RUN, ENCODER_BIN, IS_CERA, PIPELINES_DIR } from "./config";
import { logEvent } from "./eventlog";
import { t } from "./i18n";
import { notifyStateChange, saveState, state } from "./state";
import { Supervisor } from "./supervisor";
import { errorMessage, readLines } from "./util";
import { BITRATE_KBPS } from "./validate";

const RESTART_DELAY_MS = 2_000;
const STOP_TIMEOUT_MS = 5_000;
const PIPELINE_TMP = join(tmpdir(), "srtla_belacoder_pipeline");
const ENCODER_NAME = basename(ENCODER_BIN);

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

    if (write && !DRY_RUN) await Bun.write(PIPELINE_TMP, text);
    return PIPELINE_TMP;
}

/** Validate pipeline and audio settings without starting anything. */
export async function validateEncoderConfig(cfg: EncoderConfig): Promise<void> {
    await preparePipeline(await resolvePipeline(cfg.pipeline), cfg, false);
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
// Bitrate control (belacoder bitrate file / ceracoder INI config)
// ----------------------------------------------------------------------
/** ceracoder's config as persisted in the device state (defaults applied). */
export const currentCeraConfig = (): CeraConfig => state.ceracoder ?? DEFAULT_CERA_CONFIG;

async function writeControlFile(path: string, text: string, preview = `\n${text}`): Promise<void> {
    if (DRY_RUN) console.log(`[DRY-RUN] write ${path}:${preview}`);
    else await Bun.write(path, text);
}

/** Write the encoder's bitrate settings: belacoder's bitrate file (min / max in bit/s, one per line)
 *  or ceracoder's INI (which takes the min from its own section and the latency from the encoder config). */
function writeBitrateControl(minKbps: number, maxKbps: number): Promise<void> {
    if (!IS_CERA) {
        const text = `${minKbps * 1000}\n${maxKbps * 1000}\n`;
        return writeControlFile(BITRATE_FILE, text, ` ${text.replace(/\n/g, " ")}`);
    }
    const latency = state.encoder.config?.latency ?? 2000;
    return writeControlFile(CERACODER_CONF, ceraConfText(currentCeraConfig(), maxKbps, latency));
}

/** Persist ceracoder settings, rewrite the INI and reload it if the encoder is running. */
export async function updateCeraConfig(next: CeraConfig): Promise<CeraConfig> {
    state.ceracoder = next;
    await writeBitrateControl(next.minBitrate, state.encoder.config?.maxBitrate ?? 5000);
    signalEncoderReload();
    await saveState();
    return next;
}

// ----------------------------------------------------------------------
// Process management
// ----------------------------------------------------------------------
const supervisor = new Supervisor("Encoder", RESTART_DELAY_MS, onEncoderExit);

export function encoderStatus(): EncoderState {
    if (supervisor.wanted) return state.encoder;
    return { running: false, config: state.encoder.config, lastError: state.encoder.lastError };
}

/** Both encoders re-read their bitrate settings on SIGHUP while running. */
function signalEncoderReload(): void {
    const pid = supervisor.running ? supervisor.pid : undefined;
    if (pid) process.kill(pid, "SIGHUP");
}

// The encoder logs a lot; keep the last line that looks like a problem for the UI
const ERROR_LINE = /error|fail|stall|unable|cannot|could not/i;

async function pumpStderr(stream: ReadableStream<Uint8Array>): Promise<void> {
    for await (const line of readLines(stream)) {
        console.error(`[${ENCODER_NAME}] ${line}`);
        if (ERROR_LINE.test(line) && state.encoder.lastError !== line) {
            state.encoder.lastError = line;
            logEvent("error", "Encoder", line);
            notifyStateChange();
        }
    }
}

function spawnEncoder(cfg: EncoderConfig, pipelineFile: string): Bun.Subprocess {
    const args = [
        pipelineFile,
        cfg.host,
        cfg.port,
        "-d", String(cfg.delay),
        ...(IS_CERA ? ["-c", CERACODER_CONF] : ["-b", BITRATE_FILE]),
        "-l", String(cfg.latency),
        ...(cfg.streamid ? ["-s", cfg.streamid] : []),
    ];
    console.log(`Starting ${ENCODER_BIN} ${args.join(" ")}`);
    const proc = Bun.spawn([ENCODER_BIN, ...args], { stdin: "ignore", stdout: "inherit", stderr: "pipe" });
    state.encoder.pid = proc.pid;
    // Surface the noisy stderr in the console and keep the last problem line for the UI
    void pumpStderr(proc.stderr).catch(() => {});
    return proc;
}

/**
 * The encoder exits on SRT / capture failures; keep retrying like belaUI does.
 * The starter re-runs the full start sequence against the given target.
 */
function onEncoderExit(code: number | null): void {
    state.encoder.pid = undefined;
    if (!supervisor.wanted) return;
    logEvent("warn", "Encoder", t("log.encoder_exited", code, RESTART_DELAY_MS / 1000));
    state.encoder.restarts = (state.encoder.restarts ?? 0) + 1;
    state.encoder.lastError ??= `${ENCODER_NAME} exited with code ${code}`;
    notifyStateChange();
    console.warn(`${ENCODER_NAME} exited with code ${code}; restarting in ${RESTART_DELAY_MS / 1000}s`);
    supervisor.scheduleRestart();
}

export async function startEncoder(cfg: EncoderConfig): Promise<EncoderState> {
    if (supervisor.wanted) throw new Error("encoder is already running");
    // Keep the complete draft configuration even when validation or process
    // startup fails, so the UI can restore it on the next attempt.
    state.encoder = { running: false, config: cfg };
    await saveState();
    const pipelineFile = await preparePipeline(await resolvePipeline(cfg.pipeline), cfg);
    await writeBitrateControl(cfg.minBitrate ?? BITRATE_KBPS.min, cfg.maxBitrate);

    state.encoder = { running: true, config: cfg, startedAt: Date.now(), restarts: 0 };
    if (DRY_RUN) {
        console.log(`[DRY-RUN] ${ENCODER_BIN} ${pipelineFile} ${cfg.host} ${cfg.port}`);
        supervisor.markWanted();
    } else {
        try {
            await supervisor.start(() => spawnEncoder(cfg, pipelineFile));
        } catch (err: unknown) {
            const msg = `Cannot start ${ENCODER_BIN}: ${errorMessage(err)}`;
            state.encoder = { running: false, config: cfg, lastError: msg };
            await saveState();
            throw new Error(msg);
        }
    }
    await saveState();
    return state.encoder;
}

export async function stopEncoder(): Promise<void> {
    await supervisor.stop(STOP_TIMEOUT_MS);
    state.encoder = { running: false, config: state.encoder.config };
    await saveState();
}

/** Change the min / max bitrate; the encoder re-reads its settings on SIGHUP. */
export async function setEncoderBitrate(minKbps: number, maxKbps: number): Promise<EncoderState> {
    if (state.encoder.config) {
        state.encoder.config = { ...state.encoder.config, minBitrate: minKbps, maxBitrate: maxKbps };
    }
    // ceracoder's INI reads the min from the persisted cera section; keep it in sync
    if (IS_CERA) state.ceracoder = { ...currentCeraConfig(), minBitrate: minKbps };
    await writeBitrateControl(minKbps, maxKbps);
    signalEncoderReload();
    await saveState();
    return encoderStatus();
}
