/*
 * Outbound WebSocket connection to a remote control server.
 *
 * Speaks the same protocol as the local API (see api.ts), with roles of the
 * transport reversed: this device dials out, then
 *   - pushes `{ "type": "event", "event": "status", ... }` on connect, on
 *     every state change and every REMOTE_INTERVAL seconds;
 *   - pushes `srtla.stats` link telemetry at most every REMOTE_STATS_INTERVAL seconds;
 *   - pushes the event log (`log`): full history on connect, then each new entry;
 *   - answers requests `{ "id", "method", "params" }` sent by the server
 *     with `{ "type": "response", ... }`.
 *
 * On connect a hello is sent first:
 *   { "type": "hello", "id": "<device id>", "role": "relay|encoder|combined", "token"?: "<token>" }
 * The token is also sent as `Authorization: Bearer <token>` on the upgrade.
 *
 * Reconnects with exponential backoff; dead links are detected via ping/pong.
 * applyRemoteSettings() re-targets the link (and re-registers the device) at
 * runtime so settings saved in the UI apply without a process restart.
 */
import { REMOTE_ID, REMOTE_INTERVAL, REMOTE_STATS_INTERVAL, REMOTE_TOKEN, REMOTE_URL, ROLE } from "./config";
import { addStatusSink, handleRequest, logHistoryEvent, statsEvent, statusEvent } from "./api";
import { latestSrtlaStats } from "./srtlaControl";
import { state } from "./state";

const BACKOFF_MIN_MS = 1_000;
const BACKOFF_MAX_MS = 30_000;
const PING_INTERVAL_MS = 15_000;
const LIVENESS_TIMEOUT_MS = 45_000;

// The global is typed by lib.dom in this project; use Bun's client typings (headers, ping, terminate)
const BunWebSocket = WebSocket as unknown as new (url: string, options?: Bun.WebSocketOptions) => Bun.WebSocket;

let ws: Bun.WebSocket | null = null;
let stopped = true;
let backoff = BACKOFF_MIN_MS;
// Endpoint the link is (re)connecting to; the config constants are the initial values
let target = { url: REMOTE_URL, token: REMOTE_TOKEN || null };
let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
let pingTimer: ReturnType<typeof setInterval> | null = null;
let statusTimer: ReturnType<typeof setInterval> | null = null;
let lastSeen = 0;
let removeSink: (() => void) | null = null;

const isOpen = (): boolean => ws !== null && ws.readyState === WebSocket.OPEN;

// Never log the token-bearing parts of the URL
const safeUrl = (): string => {
    try {
        const u = new URL(target.url);
        u.username = u.password = "";
        u.search = "";
        return u.toString();
    } catch {
        return "(invalid url)";
    }
};

function send(msg: string): void {
    if (isOpen()) ws?.send(msg);
}

async function sendStatus(): Promise<void> {
    try {
        send(await statusEvent());
    } catch (err: unknown) {
        console.error("[remote] status failed:", err instanceof Error ? err.message : String(err));
    }
}

function clearTimers(): void {
    if (pingTimer) clearInterval(pingTimer);
    if (statusTimer) clearInterval(statusTimer);
    pingTimer = statusTimer = null;
}

/** Only requests (objects with a `method`) are dispatched; other frames are ignored. */
function isRequest(text: string): boolean {
    try {
        const msg: unknown = JSON.parse(text);
        return !!msg && typeof msg === "object" && !Array.isArray(msg) && "method" in msg;
    } catch {
        return true;   // let handleRequest produce the "Invalid JSON" error
    }
}

function connect(): void {
    if (stopped) return;
    reconnectTimer = null;

    // The saved hostname/role are the live identity; the startup constants are
    // the fallback (a hostname change therefore re-registers the device too)
    const id = state.settings?.hostname ?? REMOTE_ID;
    const role = state.settings?.role ?? ROLE;
    const headers: Record<string, string> = { "x-device-id": id, "x-device-role": role };
    if (target.token) headers.authorization = `Bearer ${target.token}`;

    console.log(`[remote] connecting to ${safeUrl()} as "${id}"...`);
    const sock = new BunWebSocket(target.url, { headers });
    ws = sock;
    const touch = () => { lastSeen = Date.now(); };

    sock.addEventListener("open", () => {
        console.log("[remote] connected");
        backoff = BACKOFF_MIN_MS;
        touch();
        send(JSON.stringify({
            type: "hello",
            id: state.settings?.hostname ?? REMOTE_ID,
            role: state.settings?.role ?? ROLE,
            ...(state.encoder.config?.maxBitrate !== undefined
                ? { maxBitrate: state.encoder.config.maxBitrate }
                : {}),
            ...(target.token ? { token: target.token } : {}),
        }));
        send(logHistoryEvent());
        void sendStatus();
        if (REMOTE_STATS_INTERVAL > 0 && latestSrtlaStats().stats) send(statsEvent());

        pingTimer = setInterval(() => {
            if (Date.now() - lastSeen > LIVENESS_TIMEOUT_MS) {
                console.warn("[remote] no traffic from server — dropping connection");
                sock.terminate();
                return;
            }
            sock.ping();
        }, PING_INTERVAL_MS);
        if (REMOTE_INTERVAL > 0) statusTimer = setInterval(() => void sendStatus(), REMOTE_INTERVAL * 1000);
    });

    // Bun's client emits `pong` for ping replies (not in the DOM typings)
    sock.addEventListener("pong", touch);

    sock.addEventListener("message", async (ev) => {
        touch();
        const { data } = ev as unknown as { data: string | ArrayBuffer };
        const text = typeof data === "string" ? data : new TextDecoder().decode(data);
        if (!isRequest(text)) return;
        send(await handleRequest(text));
    });

    sock.addEventListener("error", () => {
        // Details follow in `close`; logging here would just duplicate
    });

    sock.addEventListener("close", (ev) => {
        clearTimers();
        if (ws === sock) ws = null;
        if (stopped) return;
        console.warn(`[remote] disconnected (${ev.code}${ev.reason ? `: ${ev.reason}` : ""}); retrying in ${backoff / 1000}s`);
        reconnectTimer = setTimeout(connect, backoff);
        backoff = Math.min(backoff * 2, BACKOFF_MAX_MS);
    });
}

export const isRemoteConnected = isOpen;

export function startRemote(): void {
    if (!target.url || !stopped) return;
    if (target.token && target.url.startsWith("ws://")) {
        console.warn("[remote] sending token over unencrypted ws:// — prefer wss://");
    }
    stopped = false;
    removeSink = addStatusSink({
        active: isOpen,
        send,
        statsIntervalMs: REMOTE_STATS_INTERVAL > 0 ? REMOTE_STATS_INTERVAL * 1000 : -1,
    });
    connect();
}

export function stopRemote(): void {
    stopped = true;
    backoff = BACKOFF_MIN_MS;
    clearTimers();
    if (reconnectTimer) clearTimeout(reconnectTimer);
    reconnectTimer = null;
    removeSink?.();
    removeSink = null;
    ws?.close(1001, "shutting down");
    ws = null;
}

/**
 * Point the link at new endpoint values (from saved settings) and re-register.
 * The current connection is torn down first, so this is also how the device
 * re-registers on the same server; a cleared `url` stops the link entirely.
 */
export function applyRemoteSettings(url: string, token?: string): void {
    stopRemote();
    target = { url, token: token || null };
    if (url) startRemote();
}
