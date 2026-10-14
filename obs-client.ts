#!/usr/bin/env bun
/**
 * obs-client.ts
 *
 * A belabox-duo device that proxies between OBS Studio (obs-websocket v5)
 * and a remote control server (server.ts). Run it on the OBS machine just
 * like client.ts:
 *
 *   bun obs-client.ts --obs ws://127.0.0.1:4455 \
 *       --remote ws://10.0.0.5:8090/device --remote-token secret
 *
 * Device side (like client.ts):
 *   - registers on the control server's /device socket by stable uuid
 *     (persisted to --state-file; `role: "obs"` in the hello),
 *   - pushes a `status` event on connect and every --remote-interval seconds,
 *   - answers `obs.request` / `obs.requestBatch` / `obs.setEventSubscriptions`
 *     requests from the server (and thereby from browser UIs),
 *   - pushes `obs.event` frames tagged `module: "obs-controller"` so the
 *     server-side dashboards pick up scene / stream / record changes.
 *
 * OBS side (ObsClient below):
 *   - single WebSocket to OBS Studio, Hello -> Identify -> Identified
 *     handshake (opcodes 0/1/2),
 *   - forwards `Request` (op 6) and `RequestBatch` (op 8) verbatim,
 *   - resolves `RequestResponse` (op 7) / `RequestBatchResponse` (op 9)
 *     by requestId,
 *   - emits `Event` (op 5) payloads to subscribers, unmodified,
 *   - auto-reconnect with exponential backoff,
 *   - emits a synthetic `ObsDisconnected` event on drop (non-standard,
 *     clearly marked),
 *   - on reconnect, replays a state snapshot as real-shaped events.
 *
 * Design rule: payloads of op 5/6/7/8/9 are opaque. This file does not rename,
 * reshape, or interpret fields inside `d`.
 *
 * The ObsClient class lives in src/obs/client.ts (pure lib, no CLI) and is
 * used in-process by the relay's `obs-controller` module (OBS client + the
 * low-bitrate switcher it now owns); this entry imports it and keeps the
 * standalone proxy below.
 *
 * Runtime: Bun (global WebSocket + WebCrypto). No Node shims.
 */

import { hostname, tmpdir } from "node:os";
import { join } from "node:path";
import type { SwitcherConfig, SwitcherMetrics } from "./public/types";
import {
	collectSrtSample,
	type SrtBaseline,
} from "./modules/obs-controller/srt-metrics";
import {
	SwitcherEngine,
	type ObsSnapshot,
} from "./modules/obs-controller/switcher-engine";
import { arg, argFail, flag, intArg } from "./src/args";
import { ApiError, optionalStringList, requireString } from "./src/params";
import { errorMessage, scrubUrl, textOf } from "./src/util";
import { REMOTE_URL_RE } from "./src/validate";
import { APP_VERSION } from "./src/version";

const SWITCHER_MODULE = "low-bitrate-switcher";

// Card-form defaults (the box has no factory of its own) — used only for the
// in-memory slice, so the status always carries the full shape
const DEFAULT_SWITCHER_SLICE: SwitcherConfig & { enabled: boolean } = {
	enabled: true,
	failBehaviour: "pause",
	autoSwitch: true,
	onlySwitchWhenStreaming: false,
	instantlySwitchOnRecover: true,
	retryAttempts: 5,
	pollIntervalMs: 1000,
	triggers: { low: 500, offline: 400, rtt: 1500 },
	// Scenes come from the card form (the real OBS scene list) — no placeholders
	scenes: { normal: "", low: "", offline: "" },
	optionalScenes: { starting: "", ending: "", privacy: "" },
	logToFile: true,
	obsSourceName: "",
};

// Shape-checked merge of a modules.configure payload into the slice —
// invalid values are kept as-is (the engine re-reads the corrected slice on
// the next save; it must never receive a malformed config)
function mergeBoxSwitcherConfig(
	cur: SwitcherConfig & { enabled: boolean },
	raw: Record<string, unknown>,
): SwitcherConfig & { enabled: boolean } {
	const next: SwitcherConfig & { enabled: boolean } = {
		...cur,
		triggers: { ...cur.triggers },
		scenes: { ...cur.scenes },
		optionalScenes: { ...cur.optionalScenes },
	};
	if (typeof raw.enabled === "boolean") next.enabled = raw.enabled;
	for (const key of [
		"autoSwitch",
		"onlySwitchWhenStreaming",
		"instantlySwitchOnRecover",
		"logToFile",
	] as const)
		if (typeof raw[key] === "boolean") next[key] = raw[key];
	if (raw.failBehaviour === "pause" || raw.failBehaviour === "ignore")
		next.failBehaviour = raw.failBehaviour;
	if (
		typeof raw.retryAttempts === "number" &&
		Number.isInteger(raw.retryAttempts) &&
		raw.retryAttempts >= 1 &&
		raw.retryAttempts <= 100
	)
		next.retryAttempts = raw.retryAttempts;
	if (
		typeof raw.pollIntervalMs === "number" &&
		raw.pollIntervalMs >= 200 &&
		raw.pollIntervalMs <= 3_600_000
	)
		next.pollIntervalMs = raw.pollIntervalMs;
	for (const key of Object.keys(next.triggers) as Array<
		keyof typeof next.triggers
	>) {
		const v = (raw.triggers as Record<string, unknown> | undefined)?.[key];
		if (typeof v === "number" && Number.isFinite(v) && v >= 0)
			next.triggers[key] = v;
	}
	for (const key of Object.keys(next.scenes) as Array<
		keyof typeof next.scenes
	>) {
		const v = (raw.scenes as Record<string, unknown> | undefined)?.[key];
		if (typeof v === "string" && v.length > 0 && v.length <= 255)
			next.scenes[key] = v;
	}
	for (const key of Object.keys(next.optionalScenes) as Array<
		keyof typeof next.optionalScenes
	>) {
		const v = (raw.optionalScenes as Record<string, unknown> | undefined)?.[
			key
		];
		if (typeof v === "string" && v.length > 0 && v.length <= 255)
			next.optionalScenes[key] = v;
	}
	if (typeof raw.obsSourceName === "string") next.obsSourceName = raw.obsSourceName;
	return next;
}

import {
	DEFAULT_EVENT_SUBSCRIPTIONS,
	EventSubscription,
	OBS_DISCONNECTED_EVENT,
	ObsClient,
	type ObsEvent,
	type ObsRequestBatch,
} from "./src/obs/client";

// Re-export the protocol lib so importers of this entry keep working.
export * from "./src/obs/client";


// ============================================================================
// Standalone proxy device: `bun obs-client.ts`
//
// Registers as an "obs" device on a belabox control server (server.ts) and
// bridges the two: requests coming over the remote socket are forwarded to
// OBS, and OBS events are pushed back to the server so server-side dashboards
// can render them.
// ============================================================================

const BACKOFF_MIN_MS = 1_000;
const BACKOFF_MAX_MS = 30_000;
const PING_INTERVAL_MS = 15_000;
const LIVENESS_TIMEOUT_MS = 45_000;

// The obs-controller module tag the control server / dashboards expect
const OBS_MODULE = "obs-controller";

// op5 events forwarded to the control server (mirrors src/modules/obs.ts).
// Note: OBS v5 output events carry no "Current" prefix — it is StreamStateChanged /
// RecordStateChanged (the same names mapResponseToEvent uses), not *CurrentRecordingStateChanged*.
const FORWARDED_EVENTS = [
	"CurrentProgramSceneChanged",
	"CurrentPreviewSceneChanged",
	"CurrentProgramSceneItemChanged",
	"CurrentTransitionChanged",
	"CurrentProgramInputChanged",
	"ActiveInputChanged",
	"SceneItemAdded",
	"SceneItemRemoved",
	"MediaInputPlaybackStateChanged",
	"MediaInputStateChanged",
	"StreamStateChanged",
	"RecordStateChanged",
	// The VU meter needs the per-input level events (absent from the defaults above).
	"InputVolumeMeters",
	"InputMute",
	"InputMuteStateChanged",
] as const;

// Case-insensitive event-name -> subscription bit (same names methods.ts accepts)
const SUBSCRIPTION_LOOKUP: Record<string, number> = Object.fromEntries(
	Object.entries(EventSubscription)
		.filter(([name]) => name !== "None")
		.map(([name, bit]) => [name.toUpperCase(), bit]),
);

// The global is typed by lib.dom in this project; use Bun's client typings (headers, ping, terminate)
const BunWebSocket = WebSocket as unknown as new (
	url: string,
	options?: Bun.WebSocketOptions,
) => Bun.WebSocket;

async function main(): Promise<void> {
	const obsUrl = arg("--obs", "ws://127.0.0.1:4455");
	const obsPassword = arg("--obs-password", process.env.OBS_PASSWORD ?? "");
	const remoteUrl = arg("--remote", process.env.SRTLA_REMOTE_URL ?? "");
	const remoteToken = arg(
		"--remote-token",
		process.env.SRTLA_REMOTE_TOKEN ?? "",
	);
	const remoteInterval = intArg("--remote-interval", 30, 0, 3600);
	const deviceName = arg("--hostname", hostname());
	const stateFile = arg("--state-file", join(tmpdir(), "obs-client.json"));

	if (flag("--help") || flag("-h")) {
		console.log(
			"Usage: bun obs-client.ts --remote ws://host:port/device" +
				" [--obs ws://127.0.0.1:4455] [--obs-password pw]" +
				" [--remote-token pw] [--hostname name] [--state-file path] [--uuid uuid]",
		);
		console.log(
			"The token/URL may also come from SRTLA_REMOTE_TOKEN / SRTLA_REMOTE_URL and OBS_PASSWORD env vars.",
		);
		process.exit(0);
	}
	if (!remoteUrl) {
		console.error(
			"Usage: bun obs-client.ts --remote ws://host:port/device" +
				" [--obs ws://127.0.0.1:4455] [--obs-password pw]" +
				" [--remote-token pw] [--hostname name] [--state-file path] [--uuid uuid]",
		);
		console.error(
			"The token/URL may also come from SRTLA_REMOTE_TOKEN / SRTLA_REMOTE_URL and OBS_PASSWORD env vars.",
		);
		process.exit(2);
	}
	if (!REMOTE_URL_RE.test(remoteUrl))
		argFail("--remote", remoteUrl, "ws:// or wss:// URL");

	// Stable device identity: the uuid is assigned once and persisted, so the
	// control server (and its dashboards) keep seeing the same device. The
	// state file also carries the switcher's slice (the engine that runs it
	// lives in this box, over this OBS connection). Pre-extraction state
	// files stored the switcher under the obs slice (switcherEnabled + nested
	// switcher) — that shape is merged into the flat slice once, here.
	const stored = (await Bun.file(stateFile)
		.json()
		.catch(() => null)) as {
		uuid?: string;
		"low-bitrate-switcher"?: unknown;
		switcherEnabled?: boolean;
		switcher?: Record<string, unknown> & { enabled?: boolean };
	} | null;
	const uuid = arg("--uuid") ?? stored?.uuid ?? crypto.randomUUID();
	const storedSlice = stored?.["low-bitrate-switcher"] as
		| (Partial<SwitcherConfig> & { enabled?: boolean })
		| undefined;
	let switcherSlice: SwitcherConfig & { enabled: boolean };
	if (storedSlice) {
		switcherSlice = { ...DEFAULT_SWITCHER_SLICE, ...storedSlice };
	} else {
		switcherSlice = { ...DEFAULT_SWITCHER_SLICE };
	}
	const writeBoxState = async (): Promise<void> => {
		await Bun.write(
			stateFile,
			JSON.stringify({ uuid, "low-bitrate-switcher": switcherSlice }, null, 2),
		);
	};
	await writeBoxState();

	const obs = new ObsClient({
		url: obsUrl,
		...(obsPassword ? { password: obsPassword } : {}),
		// The VU meter needs the InputVolumeMeters bit (absent from the defaults).
		eventSubscriptions:
			DEFAULT_EVENT_SUBSCRIPTIONS | EventSubscription.InputVolumeMeters,
		log: (msg, ...rest) => console.log(`[obs] ${msg}`, ...rest),
	});

	// The switcher engine runs here (this is the box that talks to OBS and is
	// where the card renders), so the OBS SRT numbers reach the dashboard.
	let engine: SwitcherEngine | null = null;
	let srtBaseline: SrtBaseline | null = null;
	let obsScene: string | null = null;
	let obsStreaming = false;

	let sock: Bun.WebSocket | null = null;
	let stopped = false;
	let backoff = BACKOFF_MIN_MS;
	let pingTimer: ReturnType<typeof setInterval> | null = null;
	let statusTimer: ReturnType<typeof setInterval> | null = null;
	let lastSeen = 0;

	const send = (msg: string): void => {
		if (sock && sock.readyState === WebSocket.OPEN) sock.send(msg);
	};

	const pushStatus = (): void =>
		send(
			JSON.stringify({ type: "event", event: "status", data: buildStatus() }),
		);

	// Throttled engine/SRT log (a bad source name would otherwise log every
	// poll); the box keeps its own log file, this box logs to stdout.
	let lastSwitcherWarnAt = 0;
	const switcherLog = (level: "info" | "warn" | "error", message: string): void => {
		if (level === "warn") {
			const now = Date.now();
			if (now - lastSwitcherWarnAt < 30_000) return;
			lastSwitcherWarnAt = now;
		}
		console.log(`[switcher:${level}] ${message}`);
	};

	// The switcher's live state, pushed each poll so the dashboard card shows
	// the current SRT numbers (the server fans the event out to this device's
	// viewers).
	const pushSwitcherState = (): void =>
		send(
			JSON.stringify({
				type: "event",
				event: "lowBitrateSwitcher.state",
				data: engine?.status() ?? null,
			}),
		);

	// The obs-websocket client as the engine sees it. This box owns the
	// connection, so the snapshot is always present (connected=false until the
	// websocket is identified) — the engine handles the disconnected state via
	// its failBehaviour.
	const obsSnapshot = (): ObsSnapshot => ({
		connected: obs.connected && obs.identified,
		streaming: obsStreaming,
		scene: obsScene,
	});

	const obsSetScene = async (name: string): Promise<boolean> => {
		try {
			const res = await obs.sendRequest({
				requestType: "SetCurrentProgramScene",
				requestId: crypto.randomUUID(),
				// obs-websocket 5 wants camelCase `sceneName` (PascalCase is rejected).
				requestData: { sceneName: name },
			});
			return res.requestStatus.result;
		} catch {
			return false;
		}
	};

	const collectSrtMetrics = async (): Promise<SwitcherMetrics | null> => {
		const sourceName = (switcherSlice.obsSourceName ?? "").trim();
		if (!sourceName) return null;
		const { sample, baseline } = await collectSrtSample(
			obs,
			sourceName,
			srtBaseline,
			obsStreaming,
			(message) => switcherLog("warn", message),
		);
		srtBaseline = baseline;
		return sample;
	};

	// obs-websocket 5 delivers these payloads with camelCase keys — the scene
	// as `sceneName` (events) / `currentProgramSceneName` (requests) and the
	// output as `outputActive`. Tolerate the older PascalCase forms too, so
	// the tracking works across obs-websocket versions.
	const readScene = (d: Record<string, unknown> | null | undefined): string | null => {
		if (!d) return null;
		for (const k of ["sceneName", "currentProgramSceneName", "CurrentProgramSceneName"])
			if (typeof d[k] === "string") return d[k] as string;
		return null;
	};
	const readStreaming = (d: Record<string, unknown> | null | undefined): boolean => {
		if (!d) return false;
		if (typeof d["outputActive"] === "boolean") return d["outputActive"] as boolean;
		for (const k of ["outputState", "OutputState"])
			if (typeof d[k] === "number") return (d[k] as number) === 1;
		return false;
	};

	// Warm the scene / streaming tracking from OBS (the connect + reconnect
	// state-replay re-emits these, which keep the values current).
	const warmStartObs = async (): Promise<void> => {
		try {
			const [sc, st] = await Promise.all([
				obs.sendRequest({
					requestType: "GetCurrentProgramScene",
					requestId: crypto.randomUUID(),
					requestData: {},
				}),
				obs.sendRequest({
					requestType: "GetStreamStatus",
					requestId: crypto.randomUUID(),
					requestData: {},
				}),
			]);
			const s = readScene(sc.responseData);
			if (s) obsScene = s;
			obsStreaming = readStreaming(st.responseData);
		} catch {
			// Identification is in flight; the event handlers pick it up
		}
	};

	const stopEngine = (): void => {
		engine?.stop();
		engine = null;
		srtBaseline = null;
	};

	// (Re)start the engine against the current slice. The `SwitcherEngine`
	// captures the slice object, and a save rebuilds that object — so a config
	// change recreates the engine rather than patching it in place.
	const startEngine = (): void => {
		stopEngine();
		if (!switcherSlice.enabled || !switcherSlice.obsSourceName) {
			pushSwitcherState();
			return;
		}
		engine = new SwitcherEngine(switcherSlice, {
			obs: obsSnapshot,
			setScene: obsSetScene,
			metrics: collectSrtMetrics,
			log: switcherLog,
			onUpdate: pushSwitcherState,
			now: () => Date.now(),
		});
		engine.start();
		void warmStartObs();
		console.log(
			`[switcher] started (OBS source: "${switcherSlice.obsSourceName}")`,
		);
	};

	// Outgoing requests (this box asks the control server for its device
	// registry, for the switcher's metric source options).
	let nextOutgoingId = 1;
	const outgoing = new Map<
		number,
		{ resolve: (v: unknown) => void; reject: (e: Error) => void }
	>();
	const serverRequest = (
		method: string,
		params?: Record<string, unknown>,
	): Promise<unknown> => {
		const id = nextOutgoingId++;
		return new Promise<unknown>((resolve, reject) => {
			const timer = setTimeout(() => {
				outgoing.delete(id);
				reject(new Error(`request "${method}" timed out`));
			}, 5_000);
			outgoing.set(id, {
				resolve: (v) => {
					clearTimeout(timer);
					resolve(v);
				},
				reject: (e) => {
					clearTimeout(timer);
					reject(e);
				},
			});
			send(
				JSON.stringify({
					type: "request",
					id,
					method,
					...(params ? { params } : {}),
				}),
			);
		});
	};
	const settleOutgoing = (text: string): boolean => {
		let msg: {
			type?: unknown;
			id?: unknown;
			ok?: unknown;
			result?: unknown;
			error?: unknown;
		};
		try {
			msg = JSON.parse(text);
		} catch {
			return false;
		}
		if (
			!msg ||
			typeof msg !== "object" ||
			msg.type !== "response" ||
			typeof msg.id !== "number"
		)
			return false;
		const p = outgoing.get(msg.id);
		if (!p) return false;
		outgoing.delete(msg.id);
		if (msg.ok === false)
			p.reject(
				new Error(msg.error ? String(msg.error) : "server refused the request"),
			);
		else p.resolve(msg.result);
		return true;
	};
	const failOutgoing = (reason: string): void => {
		for (const [id, p] of outgoing) {
			p.reject(new Error(reason));
			outgoing.delete(id);
		}
	};

	const pushObsEvent = (
		eventType: string,
		eventIntent: number,
		eventData?: Record<string, unknown>,
	): void =>
		send(
			JSON.stringify({
				type: "event",
				event: "obs.event",
				module: OBS_MODULE,
				data: { eventType, eventIntent, eventData },
			}),
		);

	const buildStatus = (): Record<string, unknown> => ({
		role: "obs",
		setupRequired: false,
		state: { obs: { connected: obs.identified, url: scrubUrl(obsUrl) } },
		// Live switcher state (replayed to newly-connected dashboard viewers;
		// the lowBitrateSwitcher.state events carry the live updates)
		lowBitrateSwitcher: engine?.status() ?? null,
		modules: {
			relay: { enabled: false },
			encoder: { enabled: false },
			[OBS_MODULE]: {
				enabled: true,
				obsUrl,
				obsPassword: obsPassword ? { configured: true } : "",
				sceneEvents: true,
			},
			// The switcher's persisted slice + the engine that runs over this box
			[SWITCHER_MODULE]: switcherSlice,
		},
	});

	async function handleRequest(text: string): Promise<string> {
		let id: unknown = null;
		let method = "";
		try {
			const msg: unknown = JSON.parse(text);
			if (!msg || typeof msg !== "object" || Array.isArray(msg))
				throw new ApiError("Message must be a JSON object");
			const req = msg as { id?: unknown; method?: unknown; params?: unknown };
			id = req.id ?? null;
			if (typeof req.method !== "string")
				throw new ApiError("method is required");
			method = req.method;
			const params: Record<string, unknown> =
				req.params &&
				typeof req.params === "object" &&
				!Array.isArray(req.params)
					? (req.params as Record<string, unknown>)
					: {};

			let result: unknown;
			switch (method) {
				case "obs.request": {
					// op7 passthrough: the obs-websocket v5 response `d`, statuses unmapped
					const requestType = requireString(params, "requestType");
					const requestId =
						typeof params.requestId === "string" && params.requestId
							? params.requestId
							: crypto.randomUUID();
					const requestData =
						params.requestData &&
						typeof params.requestData === "object" &&
						!Array.isArray(params.requestData)
							? (params.requestData as Record<string, unknown>)
							: {};
					result = await obs.sendRequest({
						requestType,
						requestId,
						requestData,
					});
					break;
				}
				case "obs.requestBatch": {
					const requests = params.requests;
					if (!Array.isArray(requests) || !requests.length)
						throw new ApiError("requests must be a non-empty array");
					for (const r of requests) {
						if (
							!r ||
							typeof r !== "object" ||
							typeof (r as Record<string, unknown>).requestType !== "string"
						) {
							throw new ApiError("Each request needs a string requestType");
						}
					}
					const requestId =
						typeof params.requestId === "string" && params.requestId
							? params.requestId
							: crypto.randomUUID();
					const batch: ObsRequestBatch = {
						requestId,
						requests: (requests as Array<Record<string, unknown>>).map(
							(it) => ({
								requestType: it.requestType as string,
								requestId:
									typeof it.requestId === "string" && it.requestId
										? it.requestId
										: crypto.randomUUID(),
								...(it.requestData
									? { requestData: it.requestData as Record<string, unknown> }
									: {}),
							}),
						),
						...(params.haltOnFailure !== undefined
							? { haltOnFailure: !!params.haltOnFailure }
							: {}),
						...(params.executionType !== undefined
							? { executionType: params.executionType as 0 | 1 | 2 }
							: {}),
					};
					// op9 passthrough: the obs-websocket v5 batch response `d`
					result = await obs.sendBatch(batch);
					break;
				}
				case "obs.setEventSubscriptions": {
					const names = optionalStringList(params, "eventSubscriptions") ?? [];
					const intents = names.reduce(
						(acc: number, name) =>
							acc |
							(SUBSCRIPTION_LOOKUP[name.toUpperCase()] ??
								EventSubscription.None),
						0,
					);
					obs.setEventSubscriptions(intents);
					result = { ok: true, eventSubscriptions: intents };
					break;
				}
				case "modules.configure": {
					// The browser's switcher toggle and form send their config here;
					// obsUrl / obsPassword / sceneEvents are CLI-driven and ignored.
					const id = requireString(params, "id");
					if (id !== OBS_MODULE && id !== SWITCHER_MODULE)
						throw new ApiError(`Unknown module: ${id}`, 404);
					const config =
						params.config &&
						typeof params.config === "object" &&
						!Array.isArray(params.config)
							? (params.config as Record<string, unknown>)
							: {};
					if (id === SWITCHER_MODULE)
						switcherSlice = mergeBoxSwitcherConfig(switcherSlice, config);
					await writeBoxState();
					startEngine();
					pushStatus();
					result = { ok: true };
					break;
				}
				case "lowBitrateSwitcher.save": {
					// The switcher card's Save button sends the full slice as `config`.
					const config =
						params.config &&
						typeof params.config === "object" &&
						!Array.isArray(params.config)
							? (params.config as Record<string, unknown>)
							: params;
					switcherSlice = mergeBoxSwitcherConfig(switcherSlice, config);
					await writeBoxState();
					startEngine();
					pushStatus();
					result = { ok: true };
					break;
				}
				default:
					throw new ApiError(`Unknown method: ${method}`, 404);
			}
			return JSON.stringify({ type: "response", id, method, ok: true, result });
		} catch (err: unknown) {
			const code = err instanceof ApiError ? err.code : 500;
			if (code >= 500)
				console.error(`[obs-client] ${method || "?"} failed:`, err);
			return JSON.stringify({
				type: "response",
				id,
				method,
				ok: false,
				error: errorMessage(err),
				code,
			});
		}
	}

	for (const name of FORWARDED_EVENTS) {
		obs.on(name, (data, event) => {
			// Track the engine's inputs from the forwarded events (these also
			// re-arrive via the reconnect state-replay, keeping them current).
			// obs-websocket 5 payloads use `sceneName` / `outputActive`.
			if (data) {
				if (name === "CurrentProgramSceneChanged") {
					const s = readScene(data);
					if (s) obsScene = s;
				}
				if (name === "StreamStateChanged") obsStreaming = readStreaming(data);
			}
			pushObsEvent(name, event.eventIntent, event.eventData);
			pushStatus(); // the event proves the OBS link is alive
		});
	}
	// Synthetic drop event (clearly marked as non-standard by the client)
	obs.on(OBS_DISCONNECTED_EVENT, () => {
		send(
			JSON.stringify({
				type: "event",
				event: "obs.event",
				module: OBS_MODULE,
				data: { disconnected: true },
			}),
		);
		pushStatus();
	});

	function clearTimers(): void {
		if (pingTimer) clearInterval(pingTimer);
		if (statusTimer) clearInterval(statusTimer);
		pingTimer = statusTimer = null;
	}

	function connect(): void {
		if (stopped) return;
		const headers: Record<string, string> = {
			"x-device-id": uuid,
			"x-device-role": "obs",
		};
		if (remoteToken) headers.authorization = `Bearer ${remoteToken}`;

		console.log(
			`[obs-client] connecting to ${scrubUrl(remoteUrl)} as "${deviceName}"`,
		);
		const ws = new BunWebSocket(remoteUrl, { headers });
		sock = ws;
		const touch = (): void => {
			lastSeen = Date.now();
		};

		ws.addEventListener("open", () => {
			console.log("[obs-client] connected to control server");
			backoff = BACKOFF_MIN_MS;
			touch();
			send(
				JSON.stringify({
					type: "hello",
					id: uuid,
					role: "obs",
					hostname: deviceName,
					color: "",
					version: APP_VERSION,
					...(remoteToken ? { token: remoteToken } : {}),
				}),
			);
			pushStatus();
			pingTimer = setInterval(() => {
				if (Date.now() - lastSeen > LIVENESS_TIMEOUT_MS) {
					console.warn(
						"[obs-client] no traffic from server — dropping connection",
					);
					ws.terminate();
					return;
				}
				ws.ping();
			}, PING_INTERVAL_MS);
			if (remoteInterval > 0)
				statusTimer = setInterval(pushStatus, remoteInterval * 1000);
		});

		// Bun's client emits `pong` for ping replies (not in the DOM typings)
		ws.addEventListener("pong", touch);

		ws.addEventListener("message", (ev) => {
			touch();
			const text = textOf(
				(ev as unknown as { data: string | ArrayBuffer }).data,
			);
			if (settleOutgoing(text)) return; // a reply to our own outgoing request
			// Only requests (objects with a `method`) are answered
			try {
				const msg: unknown = JSON.parse(text);
				if (
					!msg ||
					typeof msg !== "object" ||
					Array.isArray(msg) ||
					!("method" in (msg as Record<string, unknown>))
				)
					return;
			} catch {
				// let handleRequest produce the "Invalid JSON" error
			}
			void handleRequest(text).then(send);
		});

		ws.addEventListener("close", (ev) => {
			clearTimers();
			failOutgoing("disconnected from control server");
			if (sock === ws) sock = null;
			if (stopped) return;
			console.warn(
				`[obs-client] disconnected (${ev.code}${ev.reason ? `: ${ev.reason}` : ""}); retrying in ${backoff / 1000}s`,
			);
			setTimeout(connect, backoff);
			backoff = Math.min(backoff * 2, BACKOFF_MAX_MS);
		});
	}

	const shutdown = (): void => {
		if (stopped) return;
		stopped = true;
		clearTimers();
		stopEngine();
		obs.disconnect();
		sock?.close(1001, "shutting down");
		sock = null;
		process.exit(0);
	};
	process.once("SIGINT", shutdown);
	process.once("SIGTERM", shutdown);

	if (remoteToken && remoteUrl.startsWith("ws://")) {
		console.warn(
			"[obs-client] sending token over unencrypted ws:// — prefer wss://",
		);
	}
	startEngine(); // polls OBS locally; state events queue until the link opens
	connect();
}

import { realpathSync } from "node:fs";
// Only run as a standalone proxy when this file is the entry point; the
// ObsClient class and helpers are also imported in-process (the relay's
// obs-controller module, tests). In compiled binaries (`bun build
// --compile`) both argv[1] and import.meta.url live in Bun's virtual
// /$bunfs filesystem, so the path comparison can never match there —
// treat that prefix as "we are the executable".
import { fileURLToPath } from "node:url";

const isBunBinary =
	import.meta.url.includes("$bunfs") ||
	import.meta.url.includes("~BUN") ||
	import.meta.url.includes("%7EBUN");

// Safe entry detection (your existing logic)
const isEntry = (() => {
	if (isBunBinary) return true;
	const target = process.argv[1];
	if (!target) return false;
	try {
		return (
			realpathSync(fileURLToPath(import.meta.url)) === realpathSync(target)
		);
	} catch {
		return false;
	}
})();

if (isEntry) void main();
