/*
 * kick-stats module: polls Kick's public channel JSON API every 30 seconds (hard-
 * coded per spec) while enabled and emits the result as a `kick.stats` module
 * event. Latest sample is also served by the read-only `kick.stats.get` method.
 */
import { KICK_STATS_MODULE, state } from "../../src/state";
import type { DeviceModule, ModuleContext } from "../types";


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

function stopPolling(): void {
    if (timer) {
        clearInterval(timer);
        timer = null;
    }
}

/** Module lifecycle: polling only runs while the module is enabled (config from the registry ctx). */
const kickStatsModule: DeviceModule = {
    id: KICK_STATS_MODULE,
    title: "Kick stats",
    configSchema: null,
    secretFields: [],
    async start(ctx) {
        stopPolling();
        if (ctx.config["enabled"] !== true) return;
        void poll(ctx);
        timer = setInterval(() => void poll(ctx), POLL_INTERVAL_MS);
    },
    stop: async () => {
        stopPolling();
    },
    methods: ["kick.stats.get"] as const,
    events: ["kick.stats"] as const,
    async dispatch(method) {
        switch (method) {
            case "kick.stats.get":
                return { stats: latest };
            default:
                throw new Error(`unknown method ${method}`);
        }
    },
};

/** Module services: latest sample for `kick.stats.get`, config application for `modules.configure`. */
export const kickStatsServices = {
    /** Latest polled stats (null when the module has not fetched yet). */
    latest: (): (KickChannelStats & { at: number }) | null => latest,
    /** Apply the validated module config to the shared state slice (caller saves + restarts). */
    configure: (config: Record<string, unknown>) => {
        const cfg = state.settings.modules?.[KICK_STATS_MODULE];
        if (!cfg) return;
        if (typeof config.enabled === "boolean") cfg.enabled = config.enabled;
        if (typeof config.channel === "string") cfg.channel = config.channel;
    },
};

async function poll(ctx: ModuleContext): Promise<void> {
    const channel = typeof ctx.config["channel"] === "string" ? ctx.config["channel"] : "";
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
        ctx.emit("kick.stats", latest);
    } catch (err: unknown) {
        ctx.log(KICK_STATS_MODULE, `poll failed: ${err instanceof Error ? err.message : String(err)}`);
    } finally {
        polling = false;
    }
}

export { kickStatsModule };
