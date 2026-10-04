/*
 * kick-chat module: subscribes to Kick's chat WebSocket while enabled and
 * emits `kick.chat` events. Messages are deduplicated by their Kick id,
 * kept in a memory-only rolling buffer (cap 500) served by `kick.chat.get`,
 * and re-delivered (`reconnect: true`) after a reconnect so viewers can top up.
 */
import { KICK_CHAT_MODULE, state } from "../../src/state";
import type { DeviceModule } from "../types";

const CHAT_URL = "wss://kick.com/chat";
const HISTORY_CAP = 500;
const RECONNECT_BASE_MS = 1_000;
const RECONNECT_MAX_MS = 30_000;

interface KickChatMessage {
    id: string | number;
    username?: string;
    badge?: { id?: string };
    text?: string;
    ts?: number;
}

type ChatContext = { emit: (event: string, data: unknown) => void };

let ws: WebSocket | null = null;
let stopped = true;
let activeCfg: Record<string, unknown> = {};
let attempt = 0;
let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
let emit: ChatContext["emit"] = () => {};
const history: KickChatMessage[] = [];
const seen = new Set<string>();

function stopSocket(): void {
    stopped = true;
    if (reconnectTimer) {
        clearTimeout(reconnectTimer);
        reconnectTimer = null;
    }
    ws?.close();
    ws = null;
}

function connect(cfg: Record<string, unknown>): void {
    const channel = typeof cfg["channel"] === "string" ? cfg["channel"] : "";
    if (!channel) return;
    const token = cfg["token"];
    const params = new URLSearchParams({ channel }).toString().replace(/\+/g, "%20");
    const url = `${CHAT_URL}?${typeof token === "string" && token ? `${params}&token=${encodeURIComponent(token)}` : params}`;
    try {
        ws = new WebSocket(url);
    } catch {
        scheduleReconnect();
        return;
    }
    ws.addEventListener("open", () => {
        attempt = 0;
        // Re-deliver the rolling buffer so a fresh viewer can top up.
        emit("kick.chat", { reconnect: true, messages: kickChatServices.history() });
    });
    ws.addEventListener("message", (ev: MessageEvent) => {
        let msg: KickChatMessage;
        try {
            msg = JSON.parse(typeof ev.data === "string" ? ev.data : String(ev.data)) as KickChatMessage;
        } catch {
            return;
        }
        if (msg.id === undefined || msg.id === null) return;
        const key = String(msg.id);
        if (seen.has(key)) return;
        seen.add(key);
        while (seen.size > HISTORY_CAP * 2) {
            const oldest = history.shift();
            if (oldest) seen.delete(String(oldest.id));
        }
        history.push(msg);
        emit("kick.chat", { message: msg });
    });
    ws.addEventListener("close", () => {
        emit("kick.chat", { disconnected: true });
        scheduleReconnect();
    });
    ws.addEventListener("error", () => {
        ws?.close();
    });
}

function scheduleReconnect(): void {
    if (stopped) {
        ws = null;
        return;
    }
    const delay = Math.min(RECONNECT_BASE_MS * 2 ** attempt, RECONNECT_MAX_MS);
    attempt += 1;
    ws = null;
    reconnectTimer = setTimeout(() => connect(activeCfg), delay);
}

const kickChatModule: DeviceModule = {
    id: KICK_CHAT_MODULE,
    title: "Kick chat",
    configSchema: null,
    secretFields: ["token"],
    async start(ctx) {
        stopSocket();
        if (ctx.config["enabled"] !== true) return;
        emit = ctx.emit;
        activeCfg = ctx.config;
        stopped = false;
        connect(activeCfg);
    },
    stop: async () => {
        stopSocket();
    },
    methods: ["kick.chat.get"] as const,
    events: ["kick.chat"] as const,
    async dispatch(method, params) {
        switch (method) {
            case "kick.chat.get":
                // The caller merges the latest kick.stats sample (cross-module)
                return { messages: kickChatServices.history(typeof params["limit"] === "number" ? params["limit"] : undefined) };
            default:
                throw new Error(`unknown method ${method}`);
        }
    },
};

/**
 * Kick-chat services consumed by the core — `history` serves the rolling
 * buffer to `kick.chat.get`; `configure` applies the kick-chat fields of a
 * `modules.configure` call.
 */
export const kickChatServices = {
    /** Rolling buffer of the most recent chat messages (memory only). */
    history: (limit?: number): KickChatMessage[] => history.slice(-Math.max(1, limit ?? HISTORY_CAP)),
    /** Whether the chat socket is open right now. */
    connected: (): boolean => ws?.readyState === WebSocket.OPEN,
    /** Apply the kick-chat config slice (caller saves + restarts). */
    configure: (config: Record<string, unknown>) => {
        const cfg = state.settings.modules?.[KICK_CHAT_MODULE];
        if (!cfg) return;
        if (typeof config.enabled === "boolean") cfg.enabled = config.enabled;
        if (typeof config.channel === "string") cfg.channel = config.channel;
        if (typeof config.token === "string") cfg.token = config.token;
    },
};

export { kickChatModule };
