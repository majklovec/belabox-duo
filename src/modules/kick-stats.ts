/*
 * kick-stats module: polls Kick's public channel JSON API every 30 seconds (hard-
 * coded per spec) while enabled and pushes the result as a `kick.stats` event.
 * Latest sample is also served by the read-only `kick.stats.get` method.
 */
import { pushModuleEvent } from "../push";
import { KICK_STATS_MODULE, state } from "../state";

const POLL_INTERVAL_MS = 30_000;
const FETCH_TIMEOUT_MS = 10_000;

const KICK_API = "https://kick.com/api/v1";

interface KickChannelStats {
    viewers?: number;
    followers?: number;
    isLive?: boolean;
    title?: string;
}

let timer: ReturnType<typeof setInterval> | null = null;
let polling = false;
let latest: (KickChannelStats & { at: number }) | null = null;

/** Latest polled stats (null when the module has not fetched yet). */
export function kickStatsLatest(): (KickChannelStats & { at: number }) | null {
    return latest;
}

export function startKickStats(): void {
    stopKickStats();
    const cfg = state.settings.modules?.["kick-stats"];
    if (!cfg?.enabled) return;
    void poll();
    timer = setInterval(() => void poll(), POLL_INTERVAL_MS);
}

export function stopKickStats(): void {
    if (timer) {
        clearInterval(timer);
        timer = null;
    }
}

async function poll(): Promise<void> {
    const channel = state.settings.modules?.["kick-stats"]?.channel ?? "";
    if (polling || !channel) return;
    polling = true;
    try {
        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
        const res = await fetch(`${KICK_API}/channels/${encodeURIComponent(channel)}/stats`, {
            signal: controller.signal,
            headers: { accept: "application/json" },
        });
        clearTimeout(timeout);
        if (!res.ok) throw new Error(`kick stats HTTP ${res.status}`);
        const payload = (await res.json()) as { data?: KickChannelStats };
        latest = { ...(payload.data ?? {}), at: Date.now() };
        pushModuleEvent("kick.stats", latest, KICK_STATS_MODULE);
    } catch (err: unknown) {
        console.log(`[kick-stats] poll failed: ${err instanceof Error ? err.message : String(err)}`);
    } finally {
        polling = false;
    }
}
