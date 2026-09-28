/*
 * srtla_send runtime control over its JSON-RPC 2.0 Unix socket (`--control-socket`):
 * subscribes to the 1 Hz per-link `stats` topic and switches the scheduler mode /
 * quality scoring without a restart.
 * https://github.com/irlserver/srtla_send/blob/main/docs/CONTROL_PROTOCOL.md
 */
import type { Socket } from "bun";
import { rmSync } from "node:fs";

export const SRTLA_MODES = ["classic", "enhanced"] as const;
export type SrtlaMode = (typeof SRTLA_MODES)[number];

/** Per-link subset of srtla_send's `StatsSnapshot.links[]` that the UI shows. */
export interface SrtlaLinkStats {
    ip: string;
    label?: string;
    connected: boolean;
    timed_out: boolean;
    bitrate_bytes_per_sec: number;
    rtt_ms: number;
    rtt_min_ms: number;
    window: number;
    in_flight: number;
    nak_count: number;
    cc_loss_permille: number;
    cc_state?: string;
    cc_target_bps?: number;
    quality_multiplier?: number;
    base_score?: number;
    weak?: boolean;
    weak_reason?: string;
    stall_gated?: boolean;
    sole_carrier?: boolean;
}

export interface SrtlaStats {
    mode?: SrtlaMode;
    quality_enabled?: boolean;
    active_links: number;
    total_links: number;
    total_in_flight: number;
    total_window: number;
    negotiated_latency_ms?: number;
    links: SrtlaLinkStats[];
}

/** Payload of the `srtla.stats` event; `stats` is null once srtla_send stops. */
export interface SrtlaStatsEvent { at: number; stats: SrtlaStats | null; }

export interface SrtlaControlState { supported: boolean; connected: boolean; }

const RETRY_MS = 500;
const RPC_TIMEOUT_MS = 5_000;

const LINK_KEYS: readonly (keyof SrtlaLinkStats)[] = [
    "ip", "label", "connected", "timed_out", "bitrate_bytes_per_sec", "rtt_ms", "rtt_min_ms", "window",
    "in_flight", "nak_count", "cc_loss_permille", "cc_state", "cc_target_bps", "quality_multiplier",
    "base_score", "weak", "weak_reason", "stall_gated", "sole_carrier",
];
const STATS_KEYS: readonly (keyof SrtlaStats)[] = [
    "mode", "quality_enabled", "active_links", "total_links", "total_in_flight", "total_window",
    "negotiated_latency_ms",
];

const pick = <T>(src: Record<string, unknown>, keys: readonly (keyof T)[]): T =>
    Object.fromEntries(keys.filter((k) => src[k as string] !== undefined).map((k) => [k, src[k as string]])) as T;

/** Keep the pushed snapshot small: it is forwarded to browsers and the control server every second. */
function trimStats(raw: unknown): SrtlaStats | null {
    if (!raw || typeof raw !== "object") return null;
    const r = raw as Record<string, unknown>;
    const links = Array.isArray(r.links) ? r.links : [];
    return {
        ...pick<SrtlaStats>(r, STATS_KEYS),
        links: links
            .filter((l): l is Record<string, unknown> => !!l && typeof l === "object")
            .map((l) => pick<SrtlaLinkStats>(l, LINK_KEYS)),
    };
}

// ----------------------------------------------------------------------
// Binary capabilities (the BELABOX C srtla_send has no control socket)
// ----------------------------------------------------------------------
const helpCache = new Map<string, Promise<string>>();

function helpText(bin: string): Promise<string> {
    let p = helpCache.get(bin);
    if (!p) {
        p = (async () => {
            try {
                const proc = Bun.spawn([bin, "--help"], { stdout: "pipe", stderr: "pipe", stdin: "ignore" });
                const [out, err] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text()]);
                await proc.exited;
                return out + err;
            } catch {
                return "";
            }
        })();
        helpCache.set(bin, p);
    }
    return p;
}

export interface SrtlaCapabilities { controlSocket: boolean; mode: boolean; quality: boolean; }

export async function srtlaCapabilities(bin: string): Promise<SrtlaCapabilities> {
    const help = await helpText(bin);
    return {
        controlSocket: help.includes("--control-socket"),
        mode: help.includes("--mode"),
        quality: help.includes("--no-quality"),
    };
}

// ----------------------------------------------------------------------
// Connection
// ----------------------------------------------------------------------
type StatsListener = (ev: SrtlaStatsEvent) => void;
type ChangeListener = () => void;

let socketPath: string | null = null;   // non-null while srtla_send should be reachable
let sock: Socket<undefined> | null = null;
let retryTimer: ReturnType<typeof setTimeout> | null = null;
let buffer = "";
let nextId = 1;
let supported = false;
let latest: SrtlaStatsEvent = { at: 0, stats: null };
const pending = new Map<number, { resolve: (v: unknown) => void; reject: (e: Error) => void; timer: ReturnType<typeof setTimeout> }>();
const statsListeners = new Set<StatsListener>();
const changeListeners = new Set<ChangeListener>();

export const srtlaControlState = (): SrtlaControlState => ({ supported, connected: sock !== null });
export const latestSrtlaStats = (): SrtlaStatsEvent => latest;

/** Subscribe to stats pushes; returns an unsubscribe function. */
export function onSrtlaStats(listener: StatsListener): () => void {
    statsListeners.add(listener);
    return () => statsListeners.delete(listener);
}

/** Subscribe to control connection up/down; returns an unsubscribe function. */
export function onSrtlaControlChange(listener: ChangeListener): () => void {
    changeListeners.add(listener);
    return () => changeListeners.delete(listener);
}

function publishStats(stats: SrtlaStats | null): void {
    latest = { at: Date.now(), stats };
    for (const l of statsListeners) l(latest);
}

const notifyChange = () => { for (const l of changeListeners) l(); };

function failPending(reason: string): void {
    for (const p of pending.values()) {
        clearTimeout(p.timer);
        p.reject(new Error(reason));
    }
    pending.clear();
}

function handleLine(line: string): void {
    let msg: { id?: unknown; method?: unknown; params?: { data?: unknown }; result?: unknown; error?: { message?: string } };
    try {
        msg = JSON.parse(line);
    } catch {
        return;
    }
    if (typeof msg.id === "number" && pending.has(msg.id)) {
        const p = pending.get(msg.id);
        pending.delete(msg.id);
        if (!p) return;
        clearTimeout(p.timer);
        if (msg.error) p.reject(new Error(msg.error.message ?? "srtla_send error"));
        else p.resolve(msg.result);
        return;
    }
    if (msg.method === "stats.update") publishStats(trimStats(msg.params?.data));
}

function scheduleConnect(): void {
    if (!socketPath || retryTimer) return;
    retryTimer = setTimeout(() => {
        retryTimer = null;
        void connect();
    }, RETRY_MS);
}

async function connect(): Promise<void> {
    const path = socketPath;
    if (!path || sock) return;
    try {
        await Bun.connect({
            unix: path,
            socket: {
                open(s) {
                    if (socketPath !== path) {
                        s.end();
                        return;
                    }
                    sock = s;
                    buffer = "";
                    console.log(`srtla_send control socket connected (${path})`);
                    notifyChange();
                    rpc("subscribe", { topic: "stats" }).catch((err: unknown) =>
                        console.warn(`srtla_send stats subscribe failed: ${err instanceof Error ? err.message : String(err)}`));
                },
                data(_s, chunk) {
                    buffer += chunk.toString();
                    let nl: number;
                    while ((nl = buffer.indexOf("\n")) >= 0) {
                        const line = buffer.slice(0, nl).trim();
                        buffer = buffer.slice(nl + 1);
                        if (line) handleLine(line);
                    }
                },
                close(s) {
                    if (sock !== s) return;
                    sock = null;
                    failPending("srtla_send control socket closed");
                    notifyChange();
                    if (socketPath) {
                        publishStats(null);
                        scheduleConnect();
                    }
                },
                error() {
                    // `close` follows and handles the reconnect
                },
            },
        });
    } catch {
        // Socket not there yet (srtla_send still starting) or refused: keep trying while wanted
        scheduleConnect();
    }
}

/** Send a JSON-RPC request and wait for its result. */
export function rpc<T = unknown>(method: string, params?: Record<string, unknown>): Promise<T> {
    return new Promise((resolve, reject) => {
        if (!sock) {
            reject(new Error("srtla_send control socket not connected"));
            return;
        }
        const id = nextId++;
        const timer = setTimeout(() => {
            pending.delete(id);
            reject(new Error(`srtla_send ${method} timed out`));
        }, RPC_TIMEOUT_MS);
        pending.set(id, { resolve: (v) => resolve(v as T), reject, timer });
        sock.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, ...(params ? { params } : {}) })}\n`);
    });
}

/** Remove a stale socket left by a crashed srtla_send so we never talk to a dead one. */
export function prepareSrtlaControl(path: string, isSupported: boolean): void {
    supported = isSupported;
    if (!isSupported) return;
    try {
        rmSync(path, { force: true });
    } catch {}
}

/** Start (re)connecting to srtla_send's control socket; call right after spawning it. */
export function startSrtlaControl(path: string): void {
    stopSrtlaControl();
    supported = true;
    socketPath = path;
    void connect();
}

export function stopSrtlaControl(): void {
    socketPath = null;
    if (retryTimer) clearTimeout(retryTimer);
    retryTimer = null;
    const s = sock;
    sock = null;
    failPending("srtla_send control stopped");
    s?.end();
    if (latest.stats) publishStats(null);
    if (s) notifyChange();
}
