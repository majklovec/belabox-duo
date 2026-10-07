/*
 * kick-stats backend — one half of the server-side Kick channel hub. The
 * kick-stats dashboard widgets are device-independent, so the control server
 * polls Kick's public channel API here for every configured channel and
 * pushes `kick.stats` events (tagged with the channel) to dashboard websocket
 * subscribers. One instance serves all stats widgets.
 */
import { eventFrame, type StatsLive, type StatsSample } from "../types";
import type { ChannelSpecs, PublishFn } from "../widgets";

export const KICK_STATS_POLL_MS = 30_000;

/** kick-stats widget's configurable parameters (single source for the server
 * validation and the frontend editor). */
export const KICK_STATS_CONFIG_FIELDS = ["channel"] as const;

/** Channel-hub spec from one widget's config (null when no channel set). */
export function statsSpecFromConfig(config: Record<string, string> | undefined): string | null {
	const name = (config?.["channel"] ?? "").trim().toLowerCase();
	return name || null;
}
/** Per-channel latest stats sample, for the merged hub snapshot. */
export interface StatsSnapshot {
	[channel: string]: StatsLive | null;
}
const FETCH_TIMEOUT_MS = 10_000;
const KICK_API = "https://kick.com/api/v1";
/** Viewer samples kept per channel for the line chart (30s × 120 = 1 h window). */
const SERIES_CAP = 120;

type StatsChannelState = {
	channel: string;
	stats: StatsLive | null;
	series: StatsSample[];
	polling: boolean;
	timer: ReturnType<typeof setInterval> | null;
};

/** Kick's `start_time` strings are UTC without an offset ("2026-10-06 19:26:57"). */
function parseKickTime(value: string | undefined): number | undefined {
	if (!value) return undefined;
	const ms = Date.parse(value.replace(" ", "T") + "Z");
	return Number.isNaN(ms) ? undefined : ms;
}

/**
 * State manager for kick-stats channels. `sync(specs)` starts pollers for
 * channels not yet attached and stops the removed ones.
 */
export class StatsChannelManager {
	#channels = new Map<string, StatsChannelState>();
	#publish: PublishFn;

	constructor(publish: PublishFn) {
		this.#publish = publish;
	}

	start(name: string): void {
		const key = name.trim().toLowerCase();
		if (!key) return;
		this.stop(key);
		const state: StatsChannelState = { channel: key, stats: null, series: [], polling: false, timer: null };
		this.#channels.set(key, state);
		void this.#poll(state);
		state.timer = setInterval(() => void this.#poll(state), KICK_STATS_POLL_MS);
	}

	stop(channel: string): void {
		const key = channel.trim().toLowerCase();
		const state = this.#channels.get(key);
		if (!state) return;
		if (state.timer) clearInterval(state.timer);
		this.#channels.delete(key);
	}

	sync(specs: ChannelSpecs): void {
		for (const name of specs) {
			const key = name.trim().toLowerCase();
			if (key && !this.#channels.has(key)) this.start(key);
		}
		for (const key of [...this.#channels.keys()]) {
			if (!specs.has(key)) this.stop(key);
		}
	}

	startedChannels(): string[] {
		return [...this.#channels.keys()];
	}

	/** Latest sample per channel (null until the first poll lands). */
	snapshot(): StatsSnapshot {
		const out: StatsSnapshot = {};
		for (const [key, state] of this.#channels) out[key] = state.stats;
		return out;
	}

	destroy(): void {
		for (const key of this.startedChannels()) this.stop(key);
	}

	async #poll(state: StatsChannelState): Promise<void> {
		if (state.polling) return;
		state.polling = true;
		try {
			const res = await fetch(`${KICK_API}/channels/${encodeURIComponent(state.channel)}`, {
				signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
				headers: { accept: "application/json" },
			});
			if (!res.ok) throw new Error(`kick stats HTTP ${res.status}`);
			const payload = (await res.json()) as {
				followersCount?: number;
				livestream?: {
					viewers?: number;
					is_live?: boolean;
					session_title?: string;
					start_time?: string;
					categories?: { name?: string }[];
				} | null;
			};
			const stream = payload.livestream ?? null;
			const at = Date.now();
			// Offline polls record 0, so the chart shows the dip (as the reference page does).
			state.series.push({ t: at, v: stream?.viewers ?? 0 });
			if (state.series.length > SERIES_CAP) state.series.shift();
			state.stats = {
				viewers: stream?.viewers,
				followers: payload.followersCount,
				isLive: Boolean(stream?.is_live),
				title: stream?.session_title,
				category: stream?.categories?.[0]?.name,
				startTime: parseKickTime(stream?.start_time),
				at,
				series: [...state.series],
			};
			this.#publish(eventFrame("kick.stats", { channel: state.channel, stats: state.stats }));
		} catch (err: unknown) {
			console.warn(`[kick-stats ${state.channel}] poll failed: ${err instanceof Error ? err.message : String(err)}`);
		} finally {
			state.polling = false;
		}
	}
}
