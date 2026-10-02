/* Device page state: the last status / stats pushed by the device, the editable form
 * fields (prefilled from the status until the user touches them), and the RPC plumbing
 * every card's actions go through. */
import m from "mithril";
import { label, type LogEvent, methodLog } from "../../../src/logMessages";
import { errorMessage } from "../../../src/util";
import type { CeraBalancer, DeviceInfo, Pipeline, Role, SrtlaStats, SrtlaStatsEvent, Status } from "../../types";
import type { KeysOf } from "../components/ui";
import { setHeaderColor } from "../util";
import { t } from "../i18n";
import { type Params, RpcClient, RpcError, socketUrl } from "../services/rpc";
import { applyLog, log } from "./log";

export const st = {
	socketOpen: false,
	connectionLost: false,
	/** Set only when served by the control server for a remote device. */
	device: null as DeviceInfo | null,
	status: null as Status | null,
	stats: null as SrtlaStats | null,
	statsAt: 0,
	pipelines: [] as Pipeline[],
	pipelineDir: "",
	autostartBusy: false,
};

/** Form fields; strings as typed, converted on submit. */
export const fields = {
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
};

/** ceracoder bitrate control (only rendered when the device runs ceracoder). */
export const cera = {
	balancer: "adaptive" as CeraBalancer,
	adaptive: { incrStep: "", decrStep: "", incrInterval: "", decrInterval: "" },
	aimd: { incrStep: "", decrMult: "", incrInterval: "", decrInterval: "" },
};

/** Selects / checkboxes the user has changed: never clobbered by a status push. */
export const touched = new Set<string>();
/** Keys of requests in flight (buttons, toggles) — their controls are disabled meanwhile. */
export const busy = new Set<string>();
const awaitingStatus = new Set<string>();
let lastRole: Role | undefined;
let pipelinesLoaded = false;

// ----------------------------------------------------------------------
// RPC
// ----------------------------------------------------------------------
// relative to the page, works at / and /d/<id>/
const rpc = new RpcClient(() => socketUrl("ws"));

/** Start / Stop style buttons, enabled only when the streaming state allows their action. */
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

export const enabled = (id: StateButton): boolean =>
	!busy.has(id) && !awaitingStatus.has(id) && !!st.status && STATE_BUTTONS[id](st.status);

/** Run a method; logs failures the device did not. While it runs, `busy` holds `key`. */
export async function act<T = unknown>(key: string | null, method: string, params?: Params): Promise<T | undefined> {
	if (key) {
		if (busy.has(key)) return undefined;
		busy.add(key);
		m.redraw();
	}
	try {
		const result = await rpc.call<T>(method, params);
		if (key && key in STATE_BUTTONS) {
			awaitingStatus.add(key);
			setTimeout(() => {
				awaitingStatus.delete(key);
				m.redraw();
			}, AWAIT_STATUS_MS);
		}
		return result;
	} catch (err) {
		if (!(err instanceof RpcError && err.logged)) {
			const { section, action } = methodLog(method);
			log("error", section, t("mlog.failed", label(action), errorMessage(err)));
		}
		return undefined;
	} finally {
		if (key) busy.delete(key);
		m.redraw();
	}
}

/** A state button's action: runs only when the button is enabled. */
export function press(id: StateButton, method: string, params?: Params): void {
	if (enabled(id)) void act(id, method, params);
}

// ----------------------------------------------------------------------
// Status → form prefill
// ----------------------------------------------------------------------
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

function applyStatus(status: Status): void {
	if (!status?.state) return;
	st.status = status;
	awaitingStatus.clear();
	if (lastRole !== status.role) touched.clear();
	lastRole = status.role;
	syncFromStatus(status);
	m.redraw();
	if (status.role !== "relay" && !pipelinesLoaded) void loadPipelines();
}

async function loadPipelines(): Promise<void> {
	pipelinesLoaded = true;
	const result = await act<{ dir: string; pipelines: Pipeline[] }>(null, "pipelines.list");
	if (!result) {
		pipelinesLoaded = false;
		return;
	}
	st.pipelineDir = result.dir;
	st.pipelines = result.pipelines;
	const current = fields.pipeline || st.status?.state.encoder.config?.pipeline || "";
	fields.pipeline = result.pipelines.some((p) => p.id === current) ? current : "";
	m.redraw();
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
	pipelinesLoaded = false;
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
rpc.on("status", (data) => applyStatus(data as Status));
rpc.on("srtla.stats", (data) => {
	st.stats = (data as SrtlaStatsEvent).stats;
	st.statsAt = st.stats ? Date.now() : 0;
	m.redraw();
});
rpc.on("device", (data) => {
	const info = data as DeviceInfo;
	if (st.device?.online === false && info.online) pipelinesLoaded = false;
	st.device = info;
	document.title = `${info.hostname || info.id} ${t("ui.title_suffix")}`;
	if (!info.online) st.stats = null;
	m.redraw();
});
rpc.on("log", (data) => applyLog(data as LogEvent));
