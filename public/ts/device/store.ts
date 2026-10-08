/* Device state: the last status / stats pushed by the device, the editable form
 * fields (prefilled from the status until the user touches them), and the RPC
 * plumbing every card's actions go through. Card state is per connection: the
 * device page runs the global `card` below, while the dashboards page creates one
 * card per viewer websocket so its widgets run the module cards against the
 * widget's own device. */
import m from "mithril";
import { label, type LogEvent, methodLog } from "../../../src/logMessages";
import { errorMessage } from "../../../src/util";
import type {
	CeraBalancer,
	DeviceInfo,
	ModulesView,
	Pipeline,
	Role,
	SrtlaStats,
	SrtlaStatsEvent,
	Status,
} from "../../types";
import { actions, button, type KeysOf } from "../components/ui";
import { type Level } from "../icons";
import { t } from "../i18n";
import { optionalNumber, setHeaderColor } from "../util";
import { type Params, RpcClient, RpcError, socketUrl } from "../services/rpc";
import { applyLog, log } from "./log";

const newFields = () => ({
	// SRTLA receiver
	listenPort: "",
	remoteHost: "",
	remotePort: "",
	// Encoder
	pipeline: "",
	minBitrate: "",
	maxBitrate: "",
	latency: "",
	delay: "",
	streamid: "",
	encHost: "",
	encPort: "",
	audioSource: "",
	audioCodec: "aac",
	bitrateOverlay: false,
});

/** ceracoder bitrate control (only rendered when the device runs ceracoder). */
const newCera = () => ({
	balancer: "adaptive" as CeraBalancer,
	adaptive: { incrStep: "", decrStep: "", incrInterval: "", decrInterval: "" },
	aimd: { incrStep: "", decrMult: "", incrInterval: "", decrInterval: "" },
});

// Start / Stop style buttons, enabled only when the streaming state allows their action.
const STATE_BUTTONS = {
	"encoder-start": (s) => !s.state.encoder.running,
	"encoder-stop": (s) => s.state.encoder.running || (s.role === "combined" && s.state.srtla.running),
	"encoder-bitrate": (s) => s.state.encoder.running,
	"srtla-start": (s) => !s.state.srtla.running,
	"srtla-stop": (s) => s.state.srtla.running,
	"srtla-reload": (s) => s.state.srtla.running,
	"ceracoder-apply": (s) => !!s.ceracoder,
} satisfies Record<string, (s: Status) => boolean>;
export type StateButton = keyof typeof STATE_BUTTONS;

// Status pushes are debounced; keep a finished action's button disabled until the new state
// arrives (or this long, if the action changed nothing) so it does not flicker back on
const AWAIT_STATUS_MS = 2_000;

/** Live device view one card renders: last status, srtla stats, the pipeline list. */
export interface CardState {
	status: Status | null;
	stats: SrtlaStats | null;
	statsAt: number;
	pipelines: Pipeline[];
	pipelineDir: string;
}

/** A full device module card (status rows + form + actions) bound to one device connection. */
export interface DeviceCard {
	st: CardState;
	fields: ReturnType<typeof newFields>;
	cera: ReturnType<typeof newCera>;
	/** Selects / checkboxes the user has changed: never clobbered by a status push. */
	touched: Set<string>;
	/** Keys of requests in flight (buttons, toggles) — their controls are disabled meanwhile. */
	busy: Set<string>;
	enabled: (id: StateButton) => boolean;
	act: <T = unknown>(key: string | null, method: string, params?: Params) => Promise<T | undefined>;
	press: (id: StateButton, method: string, params?: Params) => void;
	selectedPipeline: () => Pipeline | undefined;
	encoderStart: () => void;
	streamButtons: (stopMethod: string) => m.Children;
	/** Apply a `status` push: state + form prefill; warms the pipeline list. */
	applyStatus: (status: Status) => void;
	/** Apply a `srtla.stats` push. */
	handleStats: (data: SrtlaStatsEvent) => void;
	loadPipelines: () => Promise<void>;
	/** Drop the cached pipeline list so the next status push re-fetches it. */
	onReconnect: () => void;
}

/**
 * Build a card bound to one device connection. `logFn` receives the browser log
 * entries for failed requests (the page log on the device page; a no-op on the
 * dashboards page, where failures are not device log entries).
 */
export function createCardHost(opts: {
	rpc: RpcClient;
	logFn?: (level: Level, section: string, message: string) => void;
}): DeviceCard {
	const { rpc, logFn } = opts;
	const st: CardState = { status: null, stats: null, statsAt: 0, pipelines: [], pipelineDir: "" };
	const fields = newFields();
	const cera = newCera();
	const touched = new Set<string>();
	const busy = new Set<string>();
	const awaiting = new Set<string>();
	let lastRole: Role | undefined;
	let pipelinesLoaded = false;

	const enabled = (id: StateButton): boolean =>
		!busy.has(id) && !awaiting.has(id) && !!st.status && STATE_BUTTONS[id](st.status);

	/** Run a method; logs failures the device did not. While it runs, `busy` holds `key`. */
	async function act<T = unknown>(key: string | null, method: string, params?: Params): Promise<T | undefined> {
		if (key) {
			if (busy.has(key)) return undefined;
			busy.add(key);
			m.redraw();
		}
		try {
			const result = await rpc.call<T>(method, params);
			if (key && key in STATE_BUTTONS) {
				awaiting.add(key);
				setTimeout(() => {
					awaiting.delete(key);
					m.redraw();
				}, AWAIT_STATUS_MS);
			}
			return result;
		} catch (err) {
			if (logFn && !(err instanceof RpcError && err.logged)) {
				const { section, action } = methodLog(method);
				logFn("error", section, t("mlog.failed", label(action), errorMessage(err)));
			}
			return undefined;
		} finally {
			if (key) busy.delete(key);
			m.redraw();
		}
	}

	/** A state button's action: runs only when the button is enabled. */
	const press = (id: StateButton, method: string, params?: Params): void => {
		if (enabled(id)) void act(id, method, params);
	};

	const selectedPipeline = (): Pipeline | undefined => st.pipelines.find((p) => p.id === fields.pipeline);

	/** Submit the encoder / stream form (see the encoder module card for the fields). */
	const encoderStart = (): void => {
		const status = st.status;
		if (!status) return;
		const pipeline = selectedPipeline();
		const common = {
			pipeline: fields.pipeline,
			minBitrate: optionalNumber(fields.minBitrate),
			maxBitrate: optionalNumber(fields.maxBitrate),
			latency: optionalNumber(fields.latency),
			delay: optionalNumber(fields.delay),
			streamid: fields.streamid || undefined,
			// Options the selected pipeline does not support are hidden; do not send their stale values
			audioSource: pipeline?.asrc ? fields.audioSource || undefined : "default",
			audioCodec: pipeline?.acodec ? fields.audioCodec || undefined : undefined,
			bitrateOverlay: pipeline?.overlay ? fields.bitrateOverlay : false,
		};
		if (status.role === "combined") {
			if (!fields.remoteHost || !fields.remotePort) return;
			press("encoder-start", "stream.start", { ...common, remoteHost: fields.remoteHost, remotePort: fields.remotePort });
		} else {
			if (!fields.encHost || !fields.encPort) return;
			press("encoder-start", "encoder.start", { ...common, host: fields.encHost, port: fields.encPort });
		}
	};

	/** Start / Stop buttons for the stream (encoder card, or the SRTLA card of a combined device). */
	const streamButtons = (stopMethod: string) =>
		actions(
			button(t("ui.start"), { type: "submit", disabled: !enabled("encoder-start") }),
			button(t("ui.stop"), {
				class: "danger",
				disabled: !enabled("encoder-stop"),
				onclick: () => press("encoder-stop", stopMethod),
			}),
		);

	// ------------------------------------------------------------------ prefill
	/** Fill an empty form field from the device's settings, unless the user is typing in it. */
	function prefill<T extends object>(target: T, key: KeysOf<T, string>, value: unknown, name: string = key): void {
		if (target[key] || value == null || value === "") return;
		if ((document.activeElement as HTMLInputElement | null)?.name === name) return;
		(target as Record<string, unknown>)[key] = String(value);
	}

	function syncFromStatus(status: Status): void {
		const { srtla, srtlaTarget, encoder } = status.state;
		const combined = status.role === "combined";
		for (const key of ["listenPort", "remoteHost", "remotePort"] as const) {
			// Combined devices take the receiver from this card; fall back to the saved target
			prefill(fields, key, srtla[key] ?? (combined ? srtlaTarget?.[key] : undefined));
		}
		if (status.role === "relay") return;

		const cfg = encoder.config;
		if (!combined) {
			prefill(fields, "encHost", cfg?.host);
			prefill(fields, "encPort", cfg?.port);
		}
		// belacoder keeps the min in the encoder config; ceracoder's lives in its own section
		prefill(fields, "minBitrate", cfg?.minBitrate ?? status.ceracoder?.minBitrate);
		prefill(fields, "maxBitrate", cfg?.maxBitrate);
		prefill(fields, "latency", cfg?.latency);
		prefill(fields, "delay", cfg?.delay);
		prefill(fields, "streamid", cfg?.streamid);

		// Pipeline select: keep the choice while the pipeline is still there
		if (!fields.pipeline && !touched.has("pipeline") && cfg?.pipeline) fields.pipeline = cfg.pipeline;
		if (!st.pipelines.some((p) => p.id === fields.pipeline)) fields.pipeline = "";

		// Audio sources change as USB devices come and go; keep the current choice if still present
		const saved = cfg?.audioSource;
		const savedPresent = !!saved && status.audioSources.some((a) => a.id === saved);
		if (fields.audioSource && !status.audioSources.some((a) => a.id === fields.audioSource)) {
			fields.audioSource = savedPresent ? saved : (status.audioSources[0]?.id ?? "");
		} else if (!fields.audioSource && !touched.has("audioSource") && savedPresent) {
			fields.audioSource = saved;
		}
		if (!touched.has("audioCodec") && cfg?.audioCodec) fields.audioCodec = cfg.audioCodec;
		if (!touched.has("bitrateOverlay") && cfg) fields.bitrateOverlay = !!cfg.bitrateOverlay;

		const c = status.ceracoder;
		if (c) {
			if (!touched.has("balancer")) cera.balancer = c.balancer;
			for (const group of ["adaptive", "aimd"] as const) {
				for (const [key, value] of Object.entries(c[group])) {
					prefill(cera[group] as Record<string, string>, key, value, `${group}.${key}`);
				}
			}
		}
	}

	async function loadPipelines(): Promise<void> {
		pipelinesLoaded = true;
		const result = await act<{ dir: string; pipelines: Pipeline[] } | undefined>(null, "pipelines.list");
		if (!result || !Array.isArray(result.pipelines)) {
			pipelinesLoaded = false;
			return;
		}
		st.pipelineDir = result.dir;
		st.pipelines = result.pipelines;
		// An empty list is common right after a fresh device (the pipeline
		// scripts are copied over later): don't latch the flag, so the next
		// status push re-fetches until the directory actually has pipelines.
		if (st.pipelines.length === 0) pipelinesLoaded = false;
		const current = fields.pipeline || st.status?.state.encoder.config?.pipeline || "";
		fields.pipeline = result.pipelines.some((p) => p.id === current) ? current : "";
		m.redraw();
	}

	const applyStatus = (status: Status): void => {
		if (!status?.state) return;
		// A device on an older build may omit runtime sections — fill stopped
		// defaults so predicates and prefilling never read undefined.
		status.state.srtla ??= { running: false };
		status.state.encoder ??= { running: false };
		st.status = status;
		awaiting.clear();
		if (lastRole !== status.role) touched.clear();
		lastRole = status.role;
		syncFromStatus(status);
		m.redraw();
		// Load whenever the encoder card is shown (see app.ts): every role that
		// is not relay/obs — the module map does not gate the device's
		// pipeline API (methods.ts gates it by role only), so a box with the
		// encoder module toggled off must not be left with an empty select.
		const encoderOn = status.role !== "relay" && status.role !== "obs";
		if (encoderOn && !pipelinesLoaded) void loadPipelines();
	};

	const handleStats = (data: SrtlaStatsEvent): void => {
		st.stats = data.stats;
		st.statsAt = st.stats ? Date.now() : 0;
		m.redraw();
	};

	const onReconnect = (): void => {
		pipelinesLoaded = false;
	};

	return { st, fields, cera, touched, busy, enabled, act, press, selectedPipeline, encoderStart, streamButtons, applyStatus, handleStats, loadPipelines, onReconnect };
}

// ----------------------------------------------------------------------
// The global card: the device page's single instance
// ----------------------------------------------------------------------
// relative to the page, works at / and at /d/<id>/
// Built without auto-connect: other surfaces (dashboards) import this module
// for obsRequest/createCardHost only and must not open a socket to this device;
// the page entry (app.ts) calls connectDevice().
const rpc = new RpcClient(() => socketUrl("ws"), false);

/** Open the device websocket (idempotent). */
export const connectDevice = (): void => rpc.ensureConnected();

/** The device page's card, bound to the page's device connection. */
export const card: DeviceCard = createCardHost({ rpc, logFn: log });

/** Page-level state around the card: socket state, device info, the obs mirror. */
export const st = Object.assign(card.st, {
	socketOpen: false,
	connectionLost: false,
	/** Set only when served by the control server for a remote device. */
	device: null as DeviceInfo | null,
	autostartBusy: false,
	// Module system: persisted settings + live module state
	modules: {} as ModulesView,
	obs: { connected: false, scene: null as string | null, streaming: false, recording: false },
});

/** Form fields; strings as typed, converted on submit. */
export const fields = card.fields;
export const cera = card.cera;
export const touched = card.touched;
export const busy = card.busy;
export const enabled = card.enabled;
export const act = card.act;
export const press = card.press;
export const selectedPipeline = card.selectedPipeline;
export const encoderStart = card.encoderStart;
export const streamButtons = card.streamButtons;

// Frontend event dispatch is injected by the module registry instead of
// imported from it: store.ts is reached by every module frontend (store →
// registry → frontend → store), so a direct import creates a cycle that the
// bundler can resolve with a null module namespace. Setting the sink is the
// registry's first act; events arriving before it are dropped.
let frontendEventSink: ((event: string, data: unknown) => void) | null = null;

/** Injected by the module registry at module-evaluation time. */
export const setFrontendEventSink = (sink: (event: string, data: unknown) => void): void => {
	frontendEventSink = sink;
};

/** Route one push to the dispatcher the registry registered. */
const dispatchFrontendEvent = (event: string, data: unknown): void => frontendEventSink?.(event, data);

// ----------------------------------------------------------------------
// OBS passthrough helpers (obs-websocket v5 payloads travel verbatim;
// the obs-controller module answers these on the device side)
// ----------------------------------------------------------------------
interface ObsRequestResponse<T> {
	requestType: string;
	requestId: string;
	requestStatus: { result: boolean; code: number; comment?: string };
	responseData?: T;
}

export function obsRequest<T = Record<string, unknown>>(
	requestType: string,
	requestData: Record<string, unknown> = {},
): Promise<ObsRequestResponse<T> | undefined> {
	return act(
		null,
		"obs.request",
		{ requestType, requestId: crypto.randomUUID(), requestData },
	) as Promise<ObsRequestResponse<T> | undefined>;
}

export function obsBatch(
	requests: Array<{ requestType: string; requestData?: Record<string, unknown> }>,
	opts?: { haltOnFailure?: boolean; executionType?: 0 | 1 | 2 },
): Promise<{ requestId: string; results: ObsRequestResponse<Record<string, unknown>>[] } | undefined> {
	return act(null, "obs.requestBatch", {
		requestId: crypto.randomUUID(),
		requests: requests.map((r) => ({ ...r, requestId: crypto.randomUUID() })),
		haltOnFailure: opts?.haltOnFailure ?? false,
		executionType: opts?.executionType ?? 0,
	});
}

async function loadAppearance(): Promise<void> {
	const result = await rpc.call<{ settings: { color: string } }>("settings.get").catch(() => null);
	if (result) setHeaderColor(result.settings.color);
}

// ----------------------------------------------------------------------
// Server pushes
// ----------------------------------------------------------------------
rpc.on("open", () => {
	st.socketOpen = true;
	card.onReconnect();
	void loadAppearance();
	if (st.connectionLost) log("info", label("Connection"), t("dev.reconnected"));
	st.connectionLost = false;
	m.redraw();
});
rpc.on("close", () => {
	// Only once per outage, not on every reconnect attempt
	if (st.socketOpen) {
		st.connectionLost = true;
		log("warn", label("Connection"), t("dev.lost_reconnecting"));
	}
	st.socketOpen = false;
	st.stats = null;
	m.redraw();
});
rpc.on("status", (data) => {
	const status = data as Status;
	card.applyStatus(status);
	st.modules = status.modules ?? st.modules;
	m.redraw();
});
rpc.on("srtla.stats", (data) => card.handleStats(data as SrtlaStatsEvent));
rpc.on("device", (data) => {
	const info = data as DeviceInfo;
	if (st.device?.online === false && info.online) card.onReconnect();
	st.device = info;
	document.title = `${info.hostname || info.id} ${t("ui.title_suffix")}`;
	if (!info.online) st.stats = null;
	m.redraw();
});
rpc.on("log", (data) => applyLog(data as LogEvent));

// ----------------------------------------------------------------------
// Module events (carried with a `module` tag, routed by their name here)
// ----------------------------------------------------------------------
rpc.on("obs.event", (data) => dispatchFrontendEvent("obs.event", data));
