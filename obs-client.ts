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
 * The ObsClient class is also the one used in-process by the relay's
 * `obs-controller` module (src/modules/obs.ts).
 *
 * Runtime: Bun (global WebSocket + WebCrypto). No Node shims.
 */

import { hostname, tmpdir } from "node:os";
import { join } from "node:path";
import type { SwitcherConfig, SwitcherDeviceOption } from "./public/types";
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
	sources: {
		encoder: { enabled: false, deviceId: "" },
		relay: { enabled: false, deviceId: "" },
	},
};

// Shape-checked merge of a modules.configure payload into the slice —
// invalid values are kept as-is (the box persists, it does not run the engine)
function mergeBoxSwitcherConfig(
	cur: SwitcherConfig & { enabled: boolean },
	raw: Record<string, unknown>,
): SwitcherConfig & { enabled: boolean } {
	const next: SwitcherConfig & { enabled: boolean } = {
		...cur,
		triggers: { ...cur.triggers },
		scenes: { ...cur.scenes },
		optionalScenes: { ...cur.optionalScenes },
		sources: {
			encoder: { ...cur.sources.encoder },
			relay: { ...cur.sources.relay },
		},
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
	for (const key of ["encoder", "relay"] as const) {
		const s =
			raw.sources &&
			typeof (raw.sources as Record<string, unknown>) === "object"
				? ((raw.sources as Record<string, unknown>)[key] as
						| Record<string, unknown>
						| undefined)
				: undefined;
		if (s && typeof s === "object") {
			if (typeof s.enabled === "boolean") next.sources[key].enabled = s.enabled;
			if (typeof s.deviceId === "string")
				next.sources[key].deviceId = s.deviceId;
		}
	}
	return next;
}

export enum ObsOpCode {
	Hello = 0,
	Identify = 1,
	Identified = 2,
	Reidentify = 3,
	Event = 5,
	Request = 6,
	RequestResponse = 7,
	RequestBatch = 8,
	RequestBatchResponse = 9,
}

export const EventSubscription = {
	None: 0,
	General: 1 << 0,
	Config: 1 << 1,
	Scenes: 1 << 2,
	Inputs: 1 << 3,
	Transitions: 1 << 4,
	Filters: 1 << 5,
	Outputs: 1 << 6,
	SceneItems: 1 << 7,
	MediaInputs: 1 << 8,
	Vendors: 1 << 9,
	Ui: 1 << 10,
	InputVolumeMeters: 1 << 16,
	InputActiveStateChanged: 1 << 17,
	InputShowStateChanged: 1 << 18,
	SceneItemTransformChanged: 1 << 19,
} as const;

export const DEFAULT_EVENT_SUBSCRIPTIONS =
	EventSubscription.General |
	EventSubscription.Config |
	EventSubscription.Scenes |
	EventSubscription.Inputs |
	EventSubscription.Transitions |
	EventSubscription.Filters |
	EventSubscription.Outputs |
	EventSubscription.SceneItems |
	EventSubscription.MediaInputs;

export interface ObsRequest {
	requestType: string;
	requestId: string;
	requestData?: Record<string, unknown>;
}

export interface ObsRequestStatus {
	result: boolean;
	/** 100 = success, 2xx = protocol error, 4xx = request error. Do NOT remap. */
	code: number;
	comment?: string;
}

export interface ObsRequestResponse {
	requestType: string;
	requestId: string;
	requestStatus: ObsRequestStatus;
	responseData?: Record<string, unknown>;
}

export interface ObsRequestBatch {
	requestId: string;
	requests: ObsRequest[];
	haltOnFailure?: boolean;
	/** 0 = SerialRealtime, 1 = SerialFrame, 2 = Parallel */
	executionType?: 0 | 1 | 2;
}

export interface ObsRequestBatchResponse {
	requestId: string;
	results: ObsRequestResponse[];
}

export interface ObsEvent {
	eventType: string;
	eventIntent: number;
	eventData?: Record<string, unknown>;
}

/** Synthetic event type emitted by this client only. Not part of obs-websocket. */
export const OBS_DISCONNECTED_EVENT = "ObsDisconnected";

export interface ObsClientOptions {
	url: string;
	password?: string;
	eventSubscriptions?: number;
	autoConnect?: boolean;
	disableReconnect?: boolean;
	log?: (msg: string, ...rest: unknown[]) => void;
}

type EventHandler = (data: Record<string, unknown>, event: ObsEvent) => void;

interface PendingRequest<T> {
	resolve: (value: T) => void;
	reject: (reason: Error) => void;
	timer: ReturnType<typeof setTimeout>;
}

const RPC_VERSION = 1;
const REQUEST_TIMEOUT_MS = 10_000;
const RECONNECT_BASE_MS = 500;
const RECONNECT_MAX_MS = 15_000;

// obs-websocket close codes (protocol spec): 4010 NotIdentified, 4011
// AuthenticationFailed, 4012 UnsupportedRpcVersion, 4013
// UnsupportedMessageEncoding, 4014 UnknownOpCode, 4015 InvalidMessage
const OBS_CLOSE_HINTS: Record<number, string> = {
	4010: "not identified before close",
	4011: "authentication failed — check --obs-password against the OBS server password",
	4012: "unsupported rpcVersion",
	4013: "unsupported message encoding",
	4014: "unknown opcode",
	4015: "invalid message",
};

export class ObsClient {
	private readonly opts: ObsClientOptions & {
		autoConnect: boolean;
		disableReconnect: boolean;
		log: (msg: string, ...rest: unknown[]) => void;
	};

	private ws: WebSocket | null = null;
	private _identified = false;
	private connectPromise: Promise<void> | null = null;
	private closedByUser = false;
	private reconnectAttempt = 0;
	private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
	private eventSubscriptions: number;

	private readonly pending = new Map<
		string,
		PendingRequest<ObsRequestResponse>
	>();
	private readonly pendingBatch = new Map<
		string,
		PendingRequest<ObsRequestBatchResponse>
	>();
	private readonly listeners = new Map<string, Set<EventHandler>>();

	constructor(opts: ObsClientOptions) {
		// Normalize log args so Error objects surface as plain messages —
		// console.log prints them as stack traces with source frames.
		const userLog = opts.log ?? (() => {});
		this.opts = {
			autoConnect: true,
			disableReconnect: false,
			...opts,
			log: (msg, ...rest) =>
				userLog(msg, ...rest.map((x) => (x instanceof Error ? x.message : x))),
		};
		this.eventSubscriptions =
			opts.eventSubscriptions ?? DEFAULT_EVENT_SUBSCRIPTIONS;
		if (this.opts.autoConnect) {
			this.connect().catch((err) =>
				this.opts.log("initial connect failed", err),
			);
		}
	}

	get connected(): boolean {
		return this.ws?.readyState === WebSocket.OPEN;
	}

	get identified(): boolean {
		return this._identified;
	}

	get subscriptions(): number {
		return this.eventSubscriptions;
	}

	connect(): Promise<void> {
		if (this._identified) return Promise.resolve();
		if (this.connectPromise) return this.connectPromise;
		this.connectPromise = this.doConnect().finally(() => {
			this.connectPromise = null;
		});
		return this.connectPromise;
	}

	disconnect(): void {
		this.closedByUser = true;
		if (this.reconnectTimer) {
			clearTimeout(this.reconnectTimer);
			this.reconnectTimer = null;
		}
		this.ws?.close();
		this.ws = null;
		this._identified = false;
	}

	sendRequest(req: ObsRequest): Promise<ObsRequestResponse> {
		if (
			!this._identified ||
			!this.ws ||
			this.ws.readyState !== WebSocket.OPEN
		) {
			return Promise.reject(new Error("obs_disconnected"));
		}
		return new Promise<ObsRequestResponse>((resolve, reject) => {
			const timer = setTimeout(() => {
				this.pending.delete(req.requestId);
				reject(new Error(`obs request timeout: ${req.requestType}`));
			}, REQUEST_TIMEOUT_MS);
			this.pending.set(req.requestId, { resolve, reject, timer });
			this.ws!.send(JSON.stringify({ op: ObsOpCode.Request, d: req }));
		});
	}

	sendBatch(batch: ObsRequestBatch): Promise<ObsRequestBatchResponse> {
		if (
			!this._identified ||
			!this.ws ||
			this.ws.readyState !== WebSocket.OPEN
		) {
			return Promise.reject(new Error("obs_disconnected"));
		}
		return new Promise<ObsRequestBatchResponse>((resolve, reject) => {
			const timer = setTimeout(() => {
				this.pendingBatch.delete(batch.requestId);
				reject(new Error(`obs batch timeout: ${batch.requestId}`));
			}, REQUEST_TIMEOUT_MS);
			this.pendingBatch.set(batch.requestId, { resolve, reject, timer });
			this.ws!.send(JSON.stringify({ op: ObsOpCode.RequestBatch, d: batch }));
		});
	}

	setEventSubscriptions(intents: number): void {
		this.eventSubscriptions = intents;
		if (!this._identified || !this.ws || this.ws.readyState !== WebSocket.OPEN)
			return;
		this.ws.send(
			JSON.stringify({
				op: ObsOpCode.Reidentify,
				d: { eventSubscriptions: intents },
			}),
		);
	}

	on(eventType: string, handler: EventHandler): void {
		let set = this.listeners.get(eventType);
		if (!set) {
			set = new Set();
			this.listeners.set(eventType, set);
		}
		set.add(handler);
	}

	off(eventType: string, handler: EventHandler): void {
		this.listeners.get(eventType)?.delete(handler);
	}

	private doConnect(): Promise<void> {
		return new Promise<void>((resolve, reject) => {
			this.closedByUser = false;
			let settled = false;
			const finish = (err?: Error) => {
				if (settled) return;
				settled = true;
				if (err) reject(err);
				else resolve();
			};

			let ws: WebSocket;
			try {
				ws = new WebSocket(this.opts.url);
			} catch (err) {
				// e.g. an invalid URL throws synchronously and never fires `close`,
				// so the close-handler would never schedule a reconnect. Log and
				// keep retrying with backoff like any other failed connect.
				this.opts.log("obs connect failed", err);
				reject(err instanceof Error ? err : new Error(String(err)));
				if (!this.closedByUser && !this.opts.disableReconnect)
					this.scheduleReconnect();
				return;
			}
			this.ws = ws;

			ws.addEventListener("message", (ev: MessageEvent) => {
				let msg: { op: number; d: any };
				try {
					const raw = typeof ev.data === "string" ? ev.data : String(ev.data);
					msg = JSON.parse(raw);
				} catch (err) {
					this.opts.log("failed to parse obs message", err);
					return;
				}

				if (msg.op === ObsOpCode.Hello) {
					this.handleHello(msg.d, ws).catch((err) => {
						this.opts.log("identify failed", err);
						finish(err instanceof Error ? err : new Error(String(err)));
						ws.close();
					});
					return;
				}

				if (msg.op === ObsOpCode.Identified) {
					this._identified = true;
					this.reconnectAttempt = 0;
					this.opts.log("obs identified");
					finish();
					this.replayState().catch((err) =>
						this.opts.log("state replay failed", err),
					);
					return;
				}

				this.dispatch(msg);
			});

			ws.addEventListener("error", (ev: Event) =>
				this.opts.log("obs ws error", (ev as ErrorEvent).message ?? String(ev)),
			);

			ws.addEventListener("close", (ev: CloseEvent) => {
				const wasIdentified = this._identified;
				this._identified = false;
				this.ws = null;

				const hint = OBS_CLOSE_HINTS[ev.code];
				this.opts.log(
					`obs closed (code ${ev.code}${ev.reason ? `: ${ev.reason}` : ""}${hint ? ` — ${hint}` : ""})`,
				);
				if (!wasIdentified)
					this.opts.log("obs connection closed before identified");

				for (const p of this.pending.values()) {
					clearTimeout(p.timer);
					p.reject(new Error("obs_disconnected"));
				}
				this.pending.clear();
				for (const p of this.pendingBatch.values()) {
					clearTimeout(p.timer);
					p.reject(new Error("obs_disconnected"));
				}
				this.pendingBatch.clear();

				if (wasIdentified) this.emit(OBS_DISCONNECTED_EVENT, {});

				finish(
					new Error(
						`obs connection closed before identified (code ${ev.code}${hint ? `, ${hint}` : ""})`,
					),
				);

				if (!this.closedByUser && !this.opts.disableReconnect)
					this.scheduleReconnect();
			});
		});
	}

	private async handleHello(hello: any, ws: WebSocket): Promise<void> {
		// obs-ws v5 / protocol 1 Hello: { salt, challenge, authentication: bool,
		// protocolVersion }. Fall back to the nested shape for compat.
		const requiresAuth =
			hello?.authentication === true || !!hello?.authentication?.salt;
		const salt = (hello?.salt ?? hello?.authentication?.salt ?? "") as string;
		const challenge = (hello?.challenge ??
			hello?.authentication?.challenge ??
			"") as string;
		let authentication: string | undefined;
		if (requiresAuth) {
			if (!this.opts.password)
				throw new Error(
					"OBS requires authentication but no password was configured",
				);
			authentication = await computeAuth(this.opts.password, salt, challenge);
		}
		ws.send(
			JSON.stringify({
				op: ObsOpCode.Identify,
				d: {
					rpcVersion: RPC_VERSION,
					authentication,
					eventSubscriptions: this.eventSubscriptions,
				},
			}),
		);
	}

	private scheduleReconnect(): void {
		if (this.reconnectTimer) return;
		const delay = Math.min(
			RECONNECT_MAX_MS,
			RECONNECT_BASE_MS * 2 ** this.reconnectAttempt,
		);
		this.reconnectAttempt++;
		this.opts.log(
			`obs reconnecting in ${delay}ms (attempt ${this.reconnectAttempt})`,
		);
		this.reconnectTimer = setTimeout(() => {
			this.reconnectTimer = null;
			this.connect().catch((err) => this.opts.log("reconnect failed", err));
		}, delay);
	}

	private dispatch(msg: { op: number; d: any }): void {
		switch (msg.op) {
			case ObsOpCode.Event: {
				const ev = msg.d as ObsEvent;
				if (!ev || typeof ev.eventType !== "string") return;
				this.emit(ev.eventType, ev.eventData ?? {});
				return;
			}
			case ObsOpCode.RequestResponse: {
				const res = msg.d as ObsRequestResponse;
				const p = this.pending.get(res.requestId);
				if (!p) {
					this.opts.log("orphan requestResponse", res.requestId);
					return;
				}
				clearTimeout(p.timer);
				this.pending.delete(res.requestId);
				p.resolve(res);
				return;
			}
			case ObsOpCode.RequestBatchResponse: {
				const res = msg.d as ObsRequestBatchResponse;
				const p = this.pendingBatch.get(res.requestId);
				if (!p) {
					this.opts.log("orphan batchResponse", res.requestId);
					return;
				}
				clearTimeout(p.timer);
				this.pendingBatch.delete(res.requestId);
				p.resolve(res);
				return;
			}
			default:
				this.opts.log("unhandled obs opcode", msg.op);
		}
	}

	private emit(eventType: string, eventData: Record<string, unknown>): void {
		const set = this.listeners.get(eventType);
		if (!set || set.size === 0) return;
		const event: ObsEvent = { eventType, eventIntent: 0, eventData };
		for (const handler of set) {
			try {
				handler(eventData, event);
			} catch (err) {
				this.opts.log(`event handler for ${eventType} threw`, err);
			}
		}
	}

	private async replayState(): Promise<void> {
		const batch: ObsRequestBatch = {
			requestId: crypto.randomUUID(),
			requests: [
				{ requestType: "GetSceneList", requestId: crypto.randomUUID() },
				{
					requestType: "GetCurrentProgramScene",
					requestId: crypto.randomUUID(),
				},
				{
					requestType: "GetCurrentPreviewScene",
					requestId: crypto.randomUUID(),
				},
				{ requestType: "GetStreamStatus", requestId: crypto.randomUUID() },
				{ requestType: "GetRecordStatus", requestId: crypto.randomUUID() },
			],
			haltOnFailure: false,
			executionType: 0,
		};

		const res = await this.sendBatch(batch);
		for (const r of res.results) {
			if (!r.requestStatus.result) {
				// 506 = UNSUPPORTED_REQUEST: OBS has no preview scene until
				// Multi-View is enabled — an expected state, not a fault
				if (r.requestStatus.code !== 506)
					this.opts.log(
						`state replay: ${r.requestType} failed`,
						r.requestStatus,
					);
				continue;
			}
			const ev = mapResponseToEvent(r);
			if (ev) this.emit(ev.eventType, ev.eventData ?? {});
		}
	}
}

async function computeAuth(
	password: string,
	salt: string,
	challenge: string,
): Promise<string> {
	const enc = new TextEncoder();
	const sha256 = async (data: BufferSource): Promise<Uint8Array> =>
		new Uint8Array(await crypto.subtle.digest("SHA-256", data));
	const b64 = (bytes: Uint8Array): string => {
		let s = "";
		for (const b of bytes) s += String.fromCharCode(b);
		return btoa(s);
	};
	const secretBytes = await sha256(enc.encode(password + salt));
	const secret = b64(secretBytes);
	const authBytes = await sha256(enc.encode(secret + challenge));
	return b64(authBytes);
}

function mapResponseToEvent(r: ObsRequestResponse): ObsEvent | null {
	const d = (r.responseData ?? {}) as Record<string, any>;
	switch (r.requestType) {
		case "GetCurrentProgramScene":
			return {
				eventType: "CurrentProgramSceneChanged",
				eventIntent: EventSubscription.Scenes,
				eventData: { sceneName: d.currentProgramSceneName },
			};
		case "GetCurrentPreviewScene":
			return {
				eventType: "CurrentPreviewSceneChanged",
				eventIntent: EventSubscription.Scenes,
				eventData: { sceneName: d.currentPreviewSceneName },
			};
		case "GetStreamStatus":
			return {
				eventType: "StreamStateChanged",
				eventIntent: EventSubscription.Outputs,
				eventData: { outputActive: d.outputActive, outputState: d.outputState },
			};
		case "GetRecordStatus":
			return {
				eventType: "RecordStateChanged",
				eventIntent: EventSubscription.Outputs,
				eventData: { outputActive: d.outputActive, outputPath: d.outputPath },
			};
		case "GetSceneList":
			return {
				eventType: "SceneListChanged",
				eventIntent: EventSubscription.Scenes,
				eventData: { scenes: d.scenes },
			};
		default:
			return null;
	}
}

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
	// state file also carries the switcher's slice (the box persists settings
	// only; the engine itself runs on the full box). Pre-extraction state
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

	let sock: Bun.WebSocket | null = null;
	let stopped = false;
	let backoff = BACKOFF_MIN_MS;
	let pingTimer: ReturnType<typeof setInterval> | null = null;
	let statusTimer: ReturnType<typeof setInterval> | null = null;
	let registryTimer: ReturnType<typeof setInterval> | null = null;
	let lastSeen = 0;

	const send = (msg: string): void => {
		if (sock && sock.readyState === WebSocket.OPEN) sock.send(msg);
	};

	const pushStatus = (): void =>
		send(
			JSON.stringify({ type: "event", event: "status", data: buildStatus() }),
		);

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

	// The control server's registry, cached for the switcher's source options.
	let deviceList: SwitcherDeviceOption[] | null = null;
	const refreshDeviceList = async (): Promise<void> => {
		try {
			const result = (await serverRequest(
				"devices.list",
			)) as SwitcherDeviceOption[];
			deviceList = Array.isArray(result) ? result : [];
		} catch {
			// No registry (yet); the next refresh retries
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
		// The switcher's metric source options — the registered devices, by role
		// (empty until the first registry query succeeds)
		switcherMetricSources: {
			encoder: (deviceList ?? []).filter(
				(d) => d.role === "encoder" || d.role === "combined",
			),
			relay: (deviceList ?? []).filter(
				(d) => d.role === "relay" || d.role === "combined",
			),
		},
		state: { obs: { connected: obs.identified, url: scrubUrl(obsUrl) } },
		modules: {
			relay: { enabled: false },
			encoder: { enabled: false },
			[OBS_MODULE]: {
				enabled: true,
				obsUrl,
				obsPassword: obsPassword ? { configured: true } : "",
				sceneEvents: true,
			},
			// The switcher's persisted slice (the engine itself never runs here)
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
		obs.on(name, (_data, event) => {
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
		if (registryTimer) clearInterval(registryTimer);
		pingTimer = statusTimer = registryTimer = null;
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
			// Keep the device registry fresh for the switcher's source options
			deviceList = null;
			void refreshDeviceList().then(pushStatus);
			registryTimer = setInterval(
				() => void refreshDeviceList().then(pushStatus),
				PING_INTERVAL_MS,
			);
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
	connect();
}

// Only run as a standalone proxy when this file is the entry point; the
// ObsClient class and helpers are also imported in-process (the relay's
// obs-controller module, tests). In compiled binaries (`bun build
// --compile`) both argv[1] and import.meta.url live in Bun's virtual
// /$bunfs filesystem, so the path comparison can never match there —
// treat that prefix as "we are the executable".
import { realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";

const isEntry = (() => {
	if (import.meta.url.startsWith("file:///$bunfs/")) return true;
	const target = process.argv[1];
	if (!target) return false;
	try {
		return realpathSync(fileURLToPath(import.meta.url)) ===
			realpathSync(target);
	} catch {
		return false;
	}
})();

if (isEntry) void main();
