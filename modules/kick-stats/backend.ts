/*
 * kick-stats backend — one half of the server-side Kick channel hub. The
 * kick-stats dashboard widgets are device-independent, so the control server
 * polls Kick's public channel stats API here for every configured channel and
 * pushes `kick.stats` events (tagged with the channel) to dashboard websocket
 * subscribers. One instance serves all stats widgets.
 */
import { eventFrame, type StatsLive } from "../types";
import type { ChannelSpecs, PublishFn } from "../widgets";

export const KICK_STATS_POLL_MS = 30_000;
/** Per-channel latest stats sample, for the merged hub snapshot. */
export interface StatsSnapshot {
	[channel: string]: StatsLive | null;
}
const FETCH_TIMEOUT_MS = 10_000;
const KICK_API = "https://kick.com/api/v1";

type StatsChannelState = {
	channel: string;
	stats: StatsLive | null;
	polling: boolean;
	timer: ReturnType<typeof setInterval> | null;
};

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

	start(name: string, token: string): void {
		const key = name.trim().toLowerCase();
		if (!key) return;
		this.stop(key);
		const state: StatsChannelState = { channel: key, stats: null, polling: false, timer: null };
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
		for (const [name] of specs) {
			const key = name.trim().toLowerCase();
			if (key && !this.#channels.has(key)) this.start(key, "");
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
			const res = await fetch(`${KICK_API}/channels/${encodeURIComponent(state.channel)}/stats`, {
				signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
				headers: { accept: "application/json" },
			});
			if (!res.ok) throw new Error(`kick stats HTTP ${res.status}`);
			const payload = (await res.json()) as { data?: { viewers?: number; followers?: number; is_live?: boolean; name?: string } };
			state.stats = {
				viewers: payload.data?.viewers ?? undefined,
				followers: payload.data?.followers ?? undefined,
				isLive: Boolean(payload.data?.is_live),
				title: payload.data?.name ?? undefined,
				at: Date.now(),
			};
			this.#publish(eventFrame("kick.stats", { channel: state.channel, stats: state.stats }));
		} catch (err: unknown) {
			console.warn(`[kick-stats ${state.channel}] poll failed: ${err instanceof Error ? err.message : String(err)}`);
		} finally {
			state.polling = false;
		}
	}
}
