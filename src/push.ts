/*
 * Server → client pushes shared by the local WebSocket API and the remote control link:
 * `status` (debounced, deduplicated), `srtla.stats` (rate-limited per sink) and `log`.
 */
import { logEntries, onLogEntry } from "./eventlog";
import type { LogEvent } from "./logMessages";
import { buildStatus } from "./methods";
import { latestSrtlaStats, onSrtlaControlChange, onSrtlaStats, type SrtlaStatsEvent } from "./srtlaControl";
import { onStateChange } from "./state";
import { errorMessage } from "./util";

const BROADCAST_DEBOUNCE_MS = 250;
// srtla_send pushes about once a second; allow for jitter so a 2 s interval is not every 3 s
const STATS_JITTER_MS = 250;

export interface StatusSink {
	/** Whether anyone is listening right now (skip building status otherwise). */
	active(): boolean;
	send(msg: string): void;
	/** Minimum spacing of `srtla.stats` pushes (0 = every update, negative = never). */
	statsIntervalMs?: number;
}

// `module` tags module-generated pushes (obs/kick); core events leave it out,
// so their frame shape is unchanged for existing clients.
const event = (name: string, data: unknown, module?: string): string =>
	JSON.stringify({ type: "event", event: name, data, ...(module ? { module } : {}) });

export const statusEvent = async (): Promise<string> => event("status", await buildStatus());

/** Full event log, sent to every new connection. */
export const logHistoryEvent = (): string => event("log", { reset: true, entries: logEntries() } satisfies LogEvent);

export const statsEvent = (ev: SrtlaStatsEvent = latestSrtlaStats()): string => event("srtla.stats", ev);

const sinks = new Map<StatusSink, number>();   // sink → time of its last stats push
let broadcastTimer: ReturnType<typeof setTimeout> | null = null;
let lastBroadcast = "";

const activeSinks = () => [...sinks.keys()].filter((s) => s.active());

function scheduleBroadcast(): void {
	if (broadcastTimer || !activeSinks().length) return;
	broadcastTimer = setTimeout(async () => {
		broadcastTimer = null;
		try {
			const msg = await statusEvent();
			if (msg === lastBroadcast) return;
			lastBroadcast = msg;
			for (const sink of activeSinks()) sink.send(msg);
		} catch (err: unknown) {
			console.error("Status broadcast failed:", errorMessage(err));
		}
	}, BROADCAST_DEBOUNCE_MS);
}

function broadcastStats(ev: SrtlaStatsEvent): void {
	let msg: string | null = null;
	for (const sink of activeSinks()) {
		const interval = sink.statsIntervalMs ?? 0;
		if (interval < 0) continue;
		// A stop (`stats: null`) always goes out so viewers do not keep stale numbers
		if (ev.stats && interval > 0 && ev.at - (sinks.get(sink) ?? 0) < interval - STATS_JITTER_MS) continue;
		sinks.set(sink, ev.at);
		msg ??= statsEvent(ev);
		sink.send(msg);
	}
}

/**
 * Generic push for module-generated events (obs / kick), tagged with the
 * module ID so clients can route them. Sent to every currently active sink;
 * no deduplication, no per-stats throttling.
 */
export function pushModuleEvent(name: string, data: unknown, module: string): void {
	const msg = event(name, data, module);
	for (const sink of activeSinks()) sink.send(msg);
}

let subscribed = false;

/** Register a push target; returns an unregister function. */
export function addStatusSink(sink: StatusSink): () => void {
	sinks.set(sink, 0);
	if (!subscribed) {
		subscribed = true;
		onStateChange(scheduleBroadcast);
		onSrtlaControlChange(scheduleBroadcast);
		onSrtlaStats(broadcastStats);
		onLogEntry((entry) => {
			const msg = event("log", { entries: [entry] } satisfies LogEvent);
			for (const s of activeSinks()) s.send(msg);
		});
	}
	return () => void sinks.delete(sink);
}
