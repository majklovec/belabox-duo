/*
 * kick-chat module: subscribes to Kick's chat WebSocket while enabled and
 * pushes `kick.chat` events. Messages are deduplicated by their Kick id,
 * kept in a memory-only rolling buffer (cap 500) served by `kick.chat.get`,
 * and re-delivered (`reconnect: true`) after a reconnect so viewers can top up.
 */
import { pushModuleEvent } from "../push";
import { KICK_CHAT_MODULE, state } from "../state";

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

let ws: WebSocket | null = null;
let stopped = true;
let attempt = 0;
let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
const history: KickChatMessage[] = [];
const seen = new Set<string>();

/** Rolling buffer of the most recent chat messages (memory only). */
export function kickChatHistory(limit?: number): KickChatMessage[] {
    return history.slice(-Math.max(1, limit ?? HISTORY_CAP));
}

/** Whether the chat socket is open right now. */
export function kickChatConnected(): boolean {
    return ws?.readyState === WebSocket.OPEN;
}

export function startKickChat(): void {
    stopKickChat();
    const cfg = state.settings.modules?.["kick-chat"];
    if (!cfg?.enabled) return;
    connect();
}

export function stopKickChat(): void {
    stopped = true;
    if (reconnectTimer) {
        clearTimeout(reconnectTimer);
        reconnectTimer = null;
    }
    ws?.close();
    ws = null;
}

function channel(): string {
    return state.settings.modules?.["kick-chat"]?.channel ?? "";
}

function connect(): void {
    if (!channel()) return;
    const token = state.settings.modules?.["kick-chat"]?.token;
    const params = new URLSearchParams({ channel: channel() }).toString().replace(/\+/g, "%20");
    const url = `${CHAT_URL}?${token ? `${params}&token=${encodeURIComponent(token)}` : params}`;
    try {
        ws = new WebSocket(url);
    } catch {
        scheduleReconnect();
        return;
    }
    ws.addEventListener("open", () => {
        attempt = 0;
        // Re-deliver the rolling buffer so a fresh viewer can top up.
        pushModuleEvent("kick.chat", { reconnect: true, messages: kickChatHistory() }, KICK_CHAT_MODULE);
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
        pushModuleEvent("kick.chat", { message: msg }, KICK_CHAT_MODULE);
    });
    ws.addEventListener("close", () => {
        pushModuleEvent("kick.chat", { disconnected: true }, KICK_CHAT_MODULE);
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
    reconnectTimer = setTimeout(connect, delay);
}
