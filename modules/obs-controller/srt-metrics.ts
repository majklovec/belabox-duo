/**
 * Shared SRT stats sampling — the obs-srtla-source vendor read
 * (CallVendorRequest → GetSrtStats) plus the recent-bitrate delta math. Pure:
 * no module state, no core bag. Both the box module (backend.ts) and the
 * standalone OBS proxy (obs-client.ts) sample through here, so the SRT
 * protocol handling has a single source of truth.
 *
 * SRT semantics (obs-websocket 5 / libsrt field names, unchanged by queries):
 * counters (`byteRecvTotal`, `pktRcvRetrans`, …) and `mbpsRecvRate` cover the
 * current connection since it started; to get a *recent* bitrate we take the
 * `byteRecvTotal` delta over the poll interval. RTT (`msRTT`) is instantaneous.
 * Counters reset when the sender reconnects — the byte baseline is dropped
 * whenever the total drops below the previous one, so a fresh connection starts
 * measuring cleanly.
 */
import { randomUUID } from "node:crypto";

import type { SwitcherMetrics } from "../../public/types";

/** The SRTLA source's obs-websocket vendor (registered when obs-websocket 5 is loaded). */
const SRT_VENDOR_NAME = "obs-srtla-source";
/** The vendor request that returns the SRT connection statistics. */
const SRT_STATS_REQUEST = "GetSrtStats";

/** The minimum obs-websocket client surface needed for one SRT sample. */
export interface SrtObsClient {
	sendRequest(request: {
		requestType: string;
		requestId: string;
		requestData: Record<string, unknown>;
	}): Promise<{
		requestStatus: { result: boolean };
		responseData?: Record<string, unknown>;
	}>;
}

/** The previous `byteRecvTotal` anchor used to derive the recent bitrate. */
export interface SrtBaseline {
	bytes: number;
	at: number;
}

export interface SrtCollectResult {
	/** The SRT sample (null: client/vendor/query unavailable — a metrics gap). */
	sample: SwitcherMetrics | null;
	/** The updated byte baseline to pass on the next poll (null after a drop). */
	baseline: SrtBaseline | null;
}

/**
 * Read one SRT sample through the obs-srtla-source vendor. Returns a `null`
 * sample when the vendor is unreachable (obs-websocket 5 not loaded) or the
 * query fails; the caller then sees a metrics gap and stays put.
 *
 * An idle or disconnected source answers `success: true, connected: false`
 * with no `stats` object — reported as a connected `false` sample (the engine
 * sees it as an offline SRT link, not a metrics gap). The recent bitrate is a
 * delta of `byteRecvTotal` over the poll interval; RTT is the instantaneous
 * `msRTT`. The `warn` callback is invoked (throttling is the caller's) for
 * query failures so a bad source name does not flood the log every poll.
 */
export async function collectSrtSample(
	client: SrtObsClient,
	sourceName: string,
	prevBaseline: SrtBaseline | null,
	streaming: boolean,
	warn: (message: string) => void,
): Promise<SrtCollectResult> {
	let baseline: SrtBaseline | null = prevBaseline;

	let res: Awaited<ReturnType<SrtObsClient["sendRequest"]>>;
	try {
		res = await client.sendRequest({
			requestType: "CallVendorRequest",
			requestId: randomUUID(),
			requestData: {
				vendorName: SRT_VENDOR_NAME,
				requestType: SRT_STATS_REQUEST,
				requestData: { sourceName },
			},
		});
	} catch {
		// Vendor request threw (client dropped mid-request); metrics gap.
		baseline = null;
		warn(`SRT stats request for "${sourceName}" failed (is obs-websocket 5 loaded?)`);
		return { sample: null, baseline };
	}

	if (res.requestStatus?.result !== true) {
		baseline = null;
		warn(`SRT vendor request for "${sourceName}" failed (is obs-websocket 5 loaded?)`);
		return { sample: null, baseline };
	}

	// The vendor nests its own payload one level below the outer responseData.
	const vendor = (res.responseData?.["responseData"] ?? {}) as Record<string, unknown>;
	if (vendor["success"] !== true) {
		const err = typeof vendor["error"] === "string" ? vendor["error"] : "query failed";
		baseline = null;
		warn(`SRT stats for "${sourceName}" unavailable: ${err}`);
		return { sample: null, baseline };
	}

	// An idle or disconnected source answers success with no stats object.
	if (vendor["connected"] !== true || !vendor["stats"] || typeof vendor["stats"] !== "object") {
		baseline = null;
		return { sample: { bitrateKbps: null, rttMs: null, connected: false, streaming }, baseline };
	}
	const s = vendor["stats"] as Record<string, unknown>;
	const byteRecvTotal = typeof s["byteRecvTotal"] === "number" ? (s["byteRecvTotal"] as number) : null;
	const msRTT = typeof s["msRTT"] === "number" ? (s["msRTT"] as number) : null;

	let bitrateKbps: number | null = null;
	if (byteRecvTotal !== null) {
		const now = Date.now();
		const dtMs = baseline ? now - baseline.at : 0;
		if (baseline === null || byteRecvTotal < baseline.bytes) {
			// First sample since (re)connect: no delta to measure yet.
			baseline = { bytes: byteRecvTotal, at: now };
		} else if (dtMs > 0) {
			// kbps = (deltaBytes * 8) / dtMs, since 1 kbps == 1 bit per ms.
			bitrateKbps = Math.round(((byteRecvTotal - baseline.bytes) * 8 / dtMs) * 10) / 10;
			baseline = { bytes: byteRecvTotal, at: now };
		} else {
			baseline = { bytes: byteRecvTotal, at: now };
		}
	}

	return { sample: { bitrateKbps, rttMs: msRTT, connected: true, streaming }, baseline };
}
