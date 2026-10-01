/* Device page — a fully Mithril view. The whole page (header, cards, forms, log) is a
 * component tree over one state object; the WebSocket client mutates state and redraws. */
import m from "mithril";
import { Card, Page, badge, definitionList, field, checkField } from "./components/ui";
import { byId, type Child, formatBitrate, since } from "./dom";
import { type Level, levelIcon, roleTag } from "./icons";
import { t } from "./i18n";
import { LOG_MAX, type LogEntry, type LogEvent, label, methodLog } from "../../src/logMessages";
import type { ModemInfo } from "../../src/modems";
import type { CeraBalancer, CeraConfig, DeviceInfo, Pipeline, Role, SrtlaLinkStats, SrtlaStats, SrtlaStatsEvent, Status } from "../types";
import { RpcClient, RpcError, socketUrl } from "./services/rpc";
import { errorMessage } from "../../src/util";
import type { Params } from "./services/rpc";

const STATS_STALE_MS = 5_000;
const LEVEL_KEY: Record<Level, string> = { info: "log.level.info", warn: "log.level.warning", error: "log.level.error" };

// ----------------------------------------------------------------------
// Log
// ----------------------------------------------------------------------
// Device entries arrive via `log` events (persisted on the device; the control server adds its
// own online / offline ones); browser entries (connection, request failures) live in this page only
const logRows = new Map<string, LogEntry>();
const logKey = (e: LogEntry) => `${e.origin ?? "device"}:${e.id}`;
let nextLocalId = 1;

const formatLogTime = (at: number): m.Vnode => {
	const date = new Date(at);
	const today = date.toDateString() === new Date().toDateString();
	return m(
		"time",
		{ datetime: date.toISOString(), title: date.toLocaleString() },
		today ? date.toLocaleTimeString() : date.toLocaleString(),
	);
};

function applyLog(data: LogEvent): void {
	if (data.reset) {
		for (const [key, e] of logRows) if (e.origin !== "browser") logRows.delete(key);
	}
	for (const e of data.entries) logRows.set(logKey(e), e);
	m.redraw();
}

/** Browser-side entry; a repeat of the newest one bumps its counter instead. */
function log(level: Level, section: string, message: string): void {
	const at = Date.now();
	const newest = [...logRows.values()].reduce<LogEntry | undefined>((n, e) => (!n || e.at >= n.at ? e : n), undefined);
	if (newest?.origin === "browser" && newest.level === level && newest.section === section && newest.message === message) {
		newest.count = (newest.count ?? 1) + 1;
		newest.at = at;
	} else {
		const entry: LogEntry = { id: nextLocalId++, origin: "browser", at, level, section, message };
		logRows.set(logKey(entry), entry);
	}
	m.redraw();
}

// ----------------------------------------------------------------------
// State
// ----------------------------------------------------------------------
const st = {
	socketOpen: false,
	connectionLost: false,
	device: null as DeviceInfo | null,
	lastStatus: null as Status | null,
	stats: null as SrtlaStats | null,
	statsAt: 0,
	// Role last reported by the device; clearing touched fields when it changes
	role: "relay" as Role,
	// SRTLA form
	listenPort: "",
	remoteHost: "",
	remotePort: "",
	// Encoder form
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
	// Ceracoder bitrate-control form (the card only renders it when the device runs ceracoder)
	ceraBalancer: "adaptive" as CeraBalancer,
	ceraIncrStep: "",
	ceraDecrStep: "",
	ceraIncrInterval: "",
	ceraDecrInterval: "",
	ceraAimdIncrStep: "",
	ceraDecrMult: "",
	ceraAimdIncrInterval: "",
	ceraAimdDecrInterval: "",
	pipelines: [] as Pipeline[],
	pipelineDir: "",
	autostartBusy: false,
};
/** Selects whose value the user has changed: never clobbered by a prefilled status. */
const touched = new Set<string>();
const pipelinesLoaded = { value: false };
const inFlight = new Set<string>();
const awaitingStatus = new Set<string>();
const togglingIfaces = new Set<string>();
const busy = new Set<string>();

// ----------------------------------------------------------------------
// WebSocket RPC
// ----------------------------------------------------------------------
const rpc = new RpcClient(() => socketUrl("ws"));
 // relative to the page, works at / and /d/<id>/

/** Start / Stop style buttons, enabled only when the streaming state allows their action. */
const STATE_BUTTONS: Record<string, (s: Status) => boolean> = {
	"encoder-start": (s) => !s.state.encoder.running,
	"encoder-stop": (s) => s.state.encoder.running || (s.role === "combined" && s.state.srtla.running),
	"encoder-bitrate": (s) => s.state.encoder.running,
	"srtla-start": (s) => !s.state.srtla.running,
	"srtla-stop": (s) => s.state.srtla.running,
	"srtla-reload": (s) => s.state.srtla.running,
	"ceracoder-apply": (s) => !!s.ceracoder,
};
// Status pushes are debounced; keep a finished action's button disabled until the new state
// arrives (or this long, if the action changed nothing) so it does not flicker back on
const AWAIT_STATUS_MS = 2_000;

const stateButtonEnabled = (id: string): boolean =>
	!inFlight.has(id) && !awaitingStatus.has(id) && !!st.lastStatus && !!STATE_BUTTONS[id](st.lastStatus);

/** Run a method; logs failures the device did not, and re-enables the button afterwards. */
async function act<T = unknown>(buttonId: string | null, method: string, params?: Params): Promise<T | undefined> {
	if (buttonId) inFlight.add(buttonId);
	m.redraw();
	let ok = false;
	try {
		const result = await rpc.call<T>(method, params);
		ok = true;
		return result;
	} catch (err) {
		if (!(err instanceof RpcError && err.logged)) {
			const { section, action } = methodLog(method);
			log("error", section, t("mlog.failed", label(action), errorMessage(err)));
		}
		return undefined;
	} finally {
		if (buttonId) {
			inFlight.delete(buttonId);
			if (ok && buttonId in STATE_BUTTONS) {
				awaitingStatus.add(buttonId);
				setTimeout(() => {
					awaitingStatus.delete(buttonId);
					m.redraw();
				}, AWAIT_STATUS_MS);
			}
			m.redraw();
		}
	}
}

function renderDevice(info: DeviceInfo): void {
	const wasOnline = st.device?.online;
	st.device = info;
	document.title = `${info.hostname || info.id} ${t("ui.title_suffix")}`;
	if (wasOnline !== undefined && wasOnline !== info.online && info.online) pipelinesLoaded.value = false;
	if (!info.online) st.stats = null;
	m.redraw();
}

async function loadAppearance(): Promise<void> {
	const result = await rpc.call<{ settings: { color: string } }>("settings.get").catch(() => null);
	if (result) document.documentElement.style.setProperty("--header-color", result.settings.color);
}

rpc.on("open", () => {
	st.socketOpen = true;
	pipelinesLoaded.value = false;
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
	const next = (data as SrtlaStatsEvent).stats;
	st.stats = next;
	st.statsAt = next ? Date.now() : 0;
	m.redraw();
});
rpc.on("device", (data) => renderDevice(data as DeviceInfo));
rpc.on("log", (data) => applyLog(data as LogEvent));

// ----------------------------------------------------------------------
// Status application (prefill + role)
// ----------------------------------------------------------------------
const optionalNumber = (v: string) => (v === "" ? undefined : Number(v));

// Form fields the device's status can prefill, and the DOM id of each input (for the focus check).
type StField =
	| "listenPort" | "remoteHost" | "remotePort" | "encHost" | "encPort" | "minBitrate" | "maxBitrate" | "latency" | "delay" | "streamid"
	| "ceraBalancer" | "ceraIncrStep" | "ceraDecrStep" | "ceraIncrInterval" | "ceraDecrInterval"
	| "ceraAimdIncrStep" | "ceraDecrMult" | "ceraAimdIncrInterval" | "ceraAimdDecrInterval";
const FIELD_DNS: Record<StField, string> = {
	listenPort: "srt-listenPort",
	remoteHost: "srtla-remoteHost",
	remotePort: "srtla-remotePort",
	encHost: "enc-host",
	encPort: "enc-port",
	minBitrate: "enc-minBitrate",
	maxBitrate: "enc-maxBitrate",
	latency: "enc-latency",
	delay: "enc-delay",
	streamid: "enc-streamid",
	ceraBalancer: "cera-balancer",
	ceraIncrStep: "cera-incrStep",
	ceraDecrStep: "cera-decrStep",
	ceraIncrInterval: "cera-incrInterval",
	ceraDecrInterval: "cera-decrInterval",
	ceraAimdIncrStep: "cera-aimdIncrStep",
	ceraDecrMult: "cera-decrMult",
	ceraAimdIncrInterval: "cera-aimdIncrInterval",
	ceraAimdDecrInterval: "cera-aimdDecrInterval",
};

/** Fill an empty, unfocused form field from the device's last known settings (write goes to `st`). */
function prefill(field: StField, value: string | number | undefined): void {
	if (st[field]) return;                                     // the user (or a prior sync) already set it
	if (document.activeElement?.id === FIELD_DNS[field]) return; // never clobber a field the user is typing in
	if (value === undefined || value === "" || value == null) return;
	(st as Record<StField, string>)[field] = String(value);
}

function applyStatus(status: Status): void {
	if (!status?.state) return;
	st.lastStatus = status;
	awaitingStatus.clear();
	if (st.role !== status.role) touched.clear();
	st.role = status.role;
	syncFromStatus(status);
	m.redraw();
	if (status.role !== "relay" && !pipelinesLoaded.value) void loadPipelines();
}

/** Push the running/saved configuration into the untouched form fields. */
function syncFromStatus(status: Status): void {
	const combined = status.role === "combined";
	const s = status.state.srtla;
	if (combined) {
		// Combined devices take the receiver from this card
		for (const key of ["listenPort", "remoteHost", "remotePort"] as const) {
			prefill(key, s[key] ?? status.state.srtlaTarget?.[key]);
		}
	} else {
		prefill("listenPort", s.listenPort);
		prefill("remoteHost", s.remoteHost);
		prefill("remotePort", s.remotePort);
	}
	if (status.role === "relay") return;

	const cfg = status.state.encoder.config;
	if (cfg && !combined) {
		prefill("encHost", cfg.host);
		prefill("encPort", cfg.port);
	}
	// belacoder keeps the min in the encoder config; ceracoder's lives in its own section
	prefill("minBitrate", cfg?.minBitrate ?? status.ceracoder?.minBitrate);
	prefill("maxBitrate", cfg?.maxBitrate);
	prefill("latency", cfg?.latency);
	prefill("delay", cfg?.delay);
	prefill("streamid", cfg?.streamid);

	// Pipeline select: keep the choice if the pipeline is still there
	if (cfg?.pipeline && !touched.has("pipeline") && (!st.pipeline || st.pipelines.some((p) => p.id === st.pipeline)))
		st.pipeline = st.pipeline || cfg.pipeline;
	if (st.pipeline && !st.pipelines.some((p) => p.id === st.pipeline)) st.pipeline = "";

	// Audio sources change as USB devices come and go; keep the current choice if still present
	const source = status.audioSources.find((a) => a.id === st.audioSource);
	if (st.audioSource && !source) {
		st.audioSource = cfg?.audioSource && status.audioSources.some((a) => a.id === cfg.audioSource) ? cfg.audioSource : status.audioSources[0]?.id ?? "";
	} else if (!st.audioSource && !touched.has("audio-source") && cfg?.audioSource && status.audioSources.some((a) => a.id === cfg.audioSource)) st.audioSource = cfg.audioSource;
	if (!touched.has("audio-codec") && cfg?.audioCodec) st.audioCodec = cfg.audioCodec;
	if (!touched.has("bitrate-overlay") && cfg) st.bitrateOverlay = !!cfg.bitrateOverlay;

	// ceracoder settings exist only when the device runs the ceracoder encoder
	const cera = status.ceracoder;
	if (cera) {
		prefill("ceraBalancer", cera.balancer);
		prefill("ceraIncrStep", cera.adaptive.incrStep);
		prefill("ceraDecrStep", cera.adaptive.decrStep);
		prefill("ceraIncrInterval", cera.adaptive.incrInterval);
		prefill("ceraDecrInterval", cera.adaptive.decrInterval);
		prefill("ceraAimdIncrStep", cera.aimd.incrStep);
		prefill("ceraDecrMult", cera.aimd.decrMult);
		prefill("ceraAimdIncrInterval", cera.aimd.incrInterval);
		prefill("ceraAimdDecrInterval", cera.aimd.decrInterval);
	}
}

async function loadPipelines(): Promise<void> {
	pipelinesLoaded.value = true;
	const result = await act<{ dir: string; pipelines: Pipeline[] } | null>(null, "pipelines.list");
	if (!result) {
		pipelinesLoaded.value = false;
		return;
	}
	st.pipelineDir = result.dir;
	st.pipelines = result.pipelines;
	const current = st.pipeline || st.lastStatus?.state.encoder.config?.pipeline || "";
	st.pipeline = result.pipelines.some((p) => p.id === current) ? current : "";
	m.redraw();
}

// ----------------------------------------------------------------------
// Actions
// ----------------------------------------------------------------------
const selectedPipeline = (): Pipeline | undefined => st.pipelines.find((p) => p.id === st.pipeline);

async function encoderStart(): Promise<void> {
	const status = st.lastStatus;
	if (!status || !stateButtonEnabled("encoder-start")) return;
	const pipeline = selectedPipeline();
	const common: Params = {
		pipeline: st.pipeline,
		minBitrate: optionalNumber(st.minBitrate),
		maxBitrate: optionalNumber(st.maxBitrate),
		latency: optionalNumber(st.latency),
		delay: optionalNumber(st.delay),
		streamid: st.streamid || undefined,
		// Options the selected pipeline does not support are hidden; do not send their stale values
		audioSource: pipeline?.asrc ? st.audioSource || undefined : "default",
		audioCodec: pipeline?.acodec ? st.audioCodec || undefined : undefined,
		bitrateOverlay: pipeline?.overlay ? st.bitrateOverlay : false,
	};
	if (status.role === "combined") {
		if (!st.remoteHost || !st.remotePort) return;
		void act("encoder-start", "stream.start", { ...common, remoteHost: st.remoteHost, remotePort: st.remotePort });
	} else {
		if (!st.encHost || !st.encPort) return;
		void act("encoder-start", "encoder.start", { ...common, host: st.encHost, port: st.encPort });
	}
}

async function ceracoderApply(): Promise<void> {
	if (!stateButtonEnabled("ceracoder-apply")) return;
	void act("ceracoder-apply", "ceracoder.set", {
		balancer: st.ceraBalancer,
		adaptive: {
			incrStep: optionalNumber(st.ceraIncrStep),
			decrStep: optionalNumber(st.ceraDecrStep),
			incrInterval: optionalNumber(st.ceraIncrInterval),
			decrInterval: optionalNumber(st.ceraDecrInterval),
		},
		aimd: {
			incrStep: optionalNumber(st.ceraAimdIncrStep),
			decrMult: optionalNumber(st.ceraDecrMult),
			incrInterval: optionalNumber(st.ceraAimdIncrInterval),
			decrInterval: optionalNumber(st.ceraAimdDecrInterval),
		},
	});
}

async function srtlaStart(): Promise<void> {
	const status = st.lastStatus;
	if (!status) return;
	// Enter in the receiver fields of a combined device means "start the stream"
	if (status.role === "combined") {
		await encoderStart();
		return;
	}
	if (!stateButtonEnabled("srtla-start") || !st.listenPort || !st.remoteHost || !st.remotePort) return;
	void act("srtla-start", "srtla.start", { listenPort: st.listenPort, remoteHost: st.remoteHost, remotePort: st.remotePort });
}

async function setSrtlaOption(key: "mode" | "quality", value: string | boolean): Promise<void> {
	const busyKey = `srtla-${key}`;
	if (busy.has(busyKey)) return;
	busy.add(busyKey);
	m.redraw();
	const result = await act<{ options: Status["state"]["srtlaOptions"]; applied: boolean } | null>(null, "srtla.options", { [key]: value });
	busy.delete(busyKey);
	// The status push is debounced; do not flash the old value until it arrives
	if (result && st.lastStatus) st.lastStatus.state.srtlaOptions = result.options;
	m.redraw();
}

async function toggleIface(iface: string): Promise<void> {
	if (togglingIfaces.has(iface)) return;
	togglingIfaces.add(iface);
	m.redraw();
	await act(null, "modems.toggle", { iface });
	togglingIfaces.delete(iface);
	m.redraw();
}

async function modemAction(method: string, index: number): Promise<void> {
	if (method === "modems.reset" && !confirm(t("dev.reset_confirm", index))) return;
	const key = `modem:${method}:${index}`;
	if (busy.has(key)) return;
	busy.add(key);
	m.redraw();
	await act(null, method, { index });
	busy.delete(key);
	m.redraw();
}

async function setAutostart(enabled: boolean): Promise<void> {
	if (st.autostartBusy) return;
	const status = st.lastStatus;
	if (!status) return;
	st.autostartBusy = true;
	const previous = status.state.autostart;
	status.state.autostart = enabled;
	m.redraw();
	const result = await act<{ autostart: boolean } | null>(null, "autostart.set", { enabled });
	st.autostartBusy = false;
	status.state.autostart = result ? result.autostart : previous;
	m.redraw();
}

// ----------------------------------------------------------------------
// Rendering helpers
// ----------------------------------------------------------------------
function connBadge(): m.Vnode {
	const [text, kind]: [string, "" | "off" | "on" | "warn"] = !st.socketOpen
		? [t("dev.disconnected"), "off"]
		: st.device && !st.device.online
			? [t("dev.device_offline"), "warn"]
			: [t("dev.connected"), "on"];
	return badge(text, kind);
}

function srtlaTarget(s: Status["state"]["srtla"], role: Role): Child {
	if (!s.remoteHost) return null;
	// On combined devices the listen port is an internal belacoder → srtla_send detail
	return `${s.remoteHost}:${s.remotePort}${role === "combined" ? "" : ` ${t("dev.listen_port", s.listenPort)}`}`;
}

function controlBadge(status: Status): Child {
	const c = status.srtlaControl;
	if (c?.connected) return badge(t("dev.connected"), "on");
	if (c?.supported) return badge(t("dev.control_connecting"), "warn");
	return m(
		"span.muted",
		{ title: t("dev.control_unavailable_title") },
		t("dev.control_unavailable"),
	);
}

function linkState(l: SrtlaLinkStats): m.Vnode {
	if (l.timed_out) return badge(t("dev.link_timed_out"), "off");
	if (!l.connected) return badge(t("dev.control_connecting"), "warn");
	if (l.stall_gated) return badge(t("dev.link_stalled"), "warn");
	if (l.weak) return m("span", { title: l.weak_reason ?? "" }, badge(t("dev.link_weak"), "warn"));
	return badge(l.sole_carrier ? t("dev.link_sole") : t("dev.link_up"), "on");
}

/** Link columns for an interface; srtla_send links are matched to interfaces by source IP. */
function linkCells(l: SrtlaLinkStats | undefined, total: number): m.Vnode[] {
	const cell = (child: Child, cls = "", title?: string): m.Vnode => m("td", { class: `link-col ${cls}`.trim(), title }, child);
	if (!l) return Array.from({ length: 7 }, () => cell("—", "muted"));
	const share = total ? l.bitrate_bytes_per_sec / total : 0;
	return [
		cell(linkState(l), "", l.label ?? ""),
		cell(
			m(
				"span",
				null,
				m("meter.share", { min: 0, max: 1, value: share, title: t("dev.link_share_title", Math.round(share * 100), Math.round(l.rtt_min_ms)) }),
				formatBitrate(l.bitrate_bytes_per_sec),
			),
			"num",
		),
		cell(l.connected ? `${Math.round(l.rtt_ms)} ms` : "—", "num", t("dev.link_min_rtt", Math.round(l.rtt_min_ms))),
		cell(`${l.in_flight} / ${l.window}`, "num"),
		cell(l.nak_count, "num"),
		cell(`${((l.cc_loss_permille ?? 0) / 10).toFixed(1)}%`, "num"),
		cell(
			l.quality_multiplier !== undefined ? `×${l.quality_multiplier.toFixed(2)}` : "—",
			"num",
			l.base_score !== undefined ? t("dev.link_score", l.base_score) : "",
		),
	];
}

const formatSpeed = (mbps: number) => (mbps >= 1000 ? t("dev.unit_gbs", mbps / 1000) : t("dev.unit_mbs", mbps));

function signal(quality?: number): Child {
	if (quality === undefined) return "—";
	return m("span", null, m("meter", { min: 0, max: 100, low: 30, high: 60, optimum: 100, value: quality }), ` ${quality}%`);
}

function pipelineOptions(): m.Children {
	const groups = new Map<string, Pipeline[]>();
	for (const p of st.pipelines) groups.set(p.group, [...(groups.get(p.group) ?? []), p]);
	const nodes: m.Vnode[] = [];
	for (const [group, list] of groups) {
		const options = list.map((p) => m("option", { key: p.id, value: p.id }, p.name));
		if (group) nodes.push(m("optgroup", { key: group, label: group }, options));
		else nodes.push(...options);
	}
	if (!nodes.length) nodes.push(m("option", { value: "", disabled: true }, `${t("dev.no_pipelines", st.pipelineDir)} ${t("dev.no_pipelines_hint")}`));
	return nodes;
}

// Scheduler options: the busy value while a change is in flight, else the
// saved settings, else what the running srtla_send reports, else its defaults.
function srtlaModeValue(): string {
	const s = st.lastStatus;
	const live = s && s.state.srtla.running ? st.stats : null;
	return s?.state.srtlaOptions?.mode ?? live?.mode ?? "enhanced";
}

function srtlaQualityValue(): boolean {
	const s = st.lastStatus;
	const live = s && s.state.srtla.running ? st.stats : null;
	return s?.state.srtlaOptions?.quality ?? live?.quality_enabled ?? true;
}

function modemCard(modem: ModemInfo): m.Vnode {
	const button = (label: string, method: string, className = "secondary"): m.Vnode =>
		m("button", {
			type: "button",
			class: className,
			disabled: busy.has(`modem:${method}:${modem.index}`) || !!st.lastStatus?.state.srtla,
			onclick: () => void modemAction(method, modem.index),
		}, label);
	const connected = modem.state === "connected";
	return m(
		"article.modem",
		{ key: modem.index },
		m(
			"h3",
			null,
			m("span", `#${modem.index} ${[modem.manufacturer, modem.model].filter(Boolean).join(" ") || t("dev.modem_fallback")}`),
			badge(modem.state, connected ? "on" : modem.state === "disabled" || modem.state === "failed" ? "off" : "warn"),
		),
		definitionList([
			[t("dev.signal"), signal(modem.signalQuality)],
			[t("dev.operator"), modem.operatorName],
			[t("dev.tech"), modem.accessTech],
			[t("dev.registration"), modem.registrationState],
			[t("dev.power"), modem.powerState],
			[t("dev.imei"), modem.imei],
		]),
		m(
			"div.actions",
			button(t("ui.enable"), "modems.enable"),
			button(t("ui.disable"), "modems.disable"),
			connected ? button(t("ui.disconnect"), "modems.disconnect") : button(t("ui.connect"), "modems.connect"),
			button(t("ui.reset"), "modems.reset", "danger"),
		),
	);
}

// ----------------------------------------------------------------------
// Page view
// ----------------------------------------------------------------------
function logRowsSorted(): LogEntry[] {
	const rows = [...logRows.values()].sort((a, b) => b.at - a.at || b.id - a.id);
	for (const old of rows.splice(LOG_MAX)) logRows.delete(logKey(old));
	return rows;
}

const App: m.Component<{}, {}> = {
	view: () => {
		const status = st.lastStatus;
		const role: Role = status?.role ?? "relay";
		const combined = role === "combined";
		const hasEncoder = role !== "relay";
		const hasRelay = role !== "encoder";

		const encoderCard = hasEncoder && status
			? () => {
					const e = status.state.encoder;
					const cfg = e.config;
					const srtla = status.state.srtla;
					const state = !e.running
						? badge(t("dev.badge.stopped"), "off")
						: combined && !srtla.running
							? badge(t("dev.badge.srtla_send_down"), "warn")
							: e.pid || !e.restarts
								? badge(t("dev.badge.streaming"), "on")
								: badge(t("dev.badge.restarting"), "warn");
					// Combi devices stream into their own srtla_send, so the target row is hidden for them
					const target = cfg && `${cfg.host}:${cfg.port}`;
					const pipeline = selectedPipeline();
					const asrc = status.audioSources.find((a) => a.id === st.audioSource);
					return m(
						Card,
						{ title: t("dev.card.encoder") },
						definitionList([
							[t("dev.row.state"), state],
							// The UI only exposes ceracoder's controls when the device runs ceracoder
							[t("dev.row.encoder"), status.ceracoder ? "ceracoder" : "belacoder"],
							[t("dev.row.pipeline"), cfg?.pipeline],
							...(!combined ? ([[t("dev.row.target"), e.running ? target : null]] as [string, Child][]) : []),
							[t("dev.row.bitrate"), cfg ? t("dev.minmax_kbps", cfg.minBitrate ?? status.ceracoder?.minBitrate ?? 300, cfg.maxBitrate) : null],
							[t("dev.row.latency"), cfg ? t("dev.latency_audio", cfg.latency, cfg.delay) : null],
							[t("dev.row.audio"), cfg ? `${asrc?.name ?? cfg.audioSource ?? t("dev.audio_pipeline_default")}, ${(cfg.audioCodec ?? "aac").toUpperCase()}` : null],
							[t("dev.row.started"), e.running ? since(e.startedAt) : null],
							[t("dev.row.restarts"), e.running ? (e.restarts ?? 0) : null],
						]),
						m(
							"form",
							{ onsubmit: (e: Event) => { e.preventDefault(); void encoderStart(); } },
							field(
								t("dev.row.pipeline"),
								m("select", {
									required: true,
									value: st.pipeline,
									onchange: (e: Event) => {
										st.pipeline = (e.target as HTMLSelectElement).value;
										touched.add("pipeline");
									},
								}, pipelineOptions()),
							),
							field(
								t("dev.field.min_bitrate"),
								m("input", {
									id: "enc-minBitrate",
									type: "number",
									min: 300,
									max: 30000,
									step: 100,
									placeholder: "300",
									value: st.minBitrate,
									oninput: (e: Event) => (st.minBitrate = (e.target as HTMLInputElement).value),
								}),
							),
							field(
								t("dev.field.max_bitrate"),
								m(
									"div.actions",
									m("input", {
										id: "enc-maxBitrate",
										type: "number",
										min: 300,
										max: 30000,
										step: 100,
										placeholder: "5000",
										value: st.maxBitrate,
										oninput: (e: Event) => (st.maxBitrate = (e.target as HTMLInputElement).value),
									}),
									m(
										"button",
										{
											type: "button",
											class: "secondary",
											disabled: !stateButtonEnabled("encoder-bitrate"),
											onclick: () => void act("encoder-bitrate", "encoder.bitrate", { minBitrate: optionalNumber(st.minBitrate), maxBitrate: optionalNumber(st.maxBitrate) }),
										},
										t("dev.apply_bitrate"),
									),
								),
							),
							pipeline?.overlay
								? checkField(
										t("dev.field.bitrate_overlay"),
										m("input", {
											type: "checkbox",
											checked: st.bitrateOverlay,
											onchange: (e: Event) => {
												st.bitrateOverlay = (e.target as HTMLInputElement).checked;
												touched.add("bitrate-overlay");
											},
										}),
									)
								: null,
							status.ceracoder && (
								m(
									"div.cera",
									{ class: "section", style: "margin: 10px 0" },
									m(".head", { style: "font-weight: 600; margin-bottom: 6px" }, t("dev.cera_section")),
									field(
										t("dev.row.balancer"),
										m(
											"select",
											{
												id: "cera-balancer",
												value: st.ceraBalancer,
												onchange: (e: Event) => {
													st.ceraBalancer = (e.target as HTMLSelectElement).value as CeraBalancer;
												},
											},
											(["adaptive", "fixed", "aimd"] as CeraBalancer[]).map((b) =>
												m("option", { key: b, value: b }, t(`dev.balancer.${b}`)),
											),
										),
									),
									st.ceraBalancer === "adaptive" &&
										field(
											"adaptive",
											m(
												"div",
												{},
												m("input", {
													id: "cera-incrStep",
													type: "number",
													min: 1,
													max: 10000,
													placeholder: "30",
													title: t("dev.field.cera_incr_step"),
													value: st.ceraIncrStep,
													oninput: (e: Event) => (st.ceraIncrStep = (e.target as HTMLInputElement).value),
												}),
												m("input", {
													id: "cera-decrStep",
													type: "number",
													min: 1,
													max: 10000,
													placeholder: "100",
													title: t(`dev.field.cera_decr_step`),
													value: st.ceraDecrStep,
													oninput: (e: Event) => (st.ceraDecrStep = (e.target as HTMLInputElement).value),
												}),
												m("input", {
													id: "cera-incrInterval",
													type: "number",
													min: 10,
													max: 60000,
													placeholder: "500",
													title: t("dev.field.cera_incr_interval"),
													value: st.ceraIncrInterval,
													oninput: (e: Event) => (st.ceraIncrInterval = (e.target as HTMLInputElement).value),
												}),
												m("input", {
													id: "cera-decrInterval",
													type: "number",
													min: 10,
													max: 60000,
													placeholder: "200",
													title: t("dev.field.cera_decr_interval"),
													value: st.ceraDecrInterval,
													oninput: (e: Event) => (st.ceraDecrInterval = (e.target as HTMLInputElement).value),
												}),
											),
										),
									st.ceraBalancer === "aimd" &&
										field(
											"aimd",
											m(
												"div",
												{},
												m("input", {
													id: "cera-aimdIncrStep",
													type: "number",
													min: 1,
													max: 10000,
													placeholder: "50",
													title: t("dev.field.cera_incr_step"),
													value: st.ceraAimdIncrStep,
													oninput: (e: Event) => (st.ceraAimdIncrStep = (e.target as HTMLInputElement).value),
												}),
												m("input", {
													id: "cera-decrMult",
													type: "number",
													min: 0,
													max: 1,
													step: 0.01,
													placeholder: "0.75",
													title: t(`dev.field.cera_decr_mult`),
													value: st.ceraDecrMult,
													oninput: (e: Event) => (st.ceraDecrMult = (e.target as HTMLInputElement).value),
												}),
												m("input", {
													id: "cera-aimdIncrInterval",
													type: "number",
													min: 10,
													max: 60000,
													placeholder: "500",
													title: t(`dev.field.cera_incr_interval`),
													value: st.ceraAimdIncrInterval,
													oninput: (e: Event) => (st.ceraAimdIncrInterval = (e.target as HTMLInputElement).value),
												}),
												m("input", {
													id: "cera-aimdDecrInterval",
													type: "number",
													min: 10,
													max: 60000,
													placeholder: "200",
													title: t(`dev.field.cera_decr_interval`),
													value: st.ceraAimdDecrInterval,
													oninput: (e: Event) => (st.ceraAimdDecrInterval = (e.target as HTMLInputElement).value),
												}),
											),
										),
									m("div.actions", m("button", { type: "button", class: "primary", disabled: !stateButtonEnabled(`ceracoder-apply`), onclick: () => void ceracoderApply() }, t(`dev.apply_cera`))),
								)
							),
							m("div.break"),
							pipeline?.asrc
								? field(
										t("dev.field.audio_source"),
										m(
											"select",
											{
												value: st.audioSource,
												onchange: (e: Event) => {
													st.audioSource = (e.target as HTMLSelectElement).value;
													touched.add("audio-source");
												},
											},
											status!.audioSources.map((a) => m("option", { key: a.id, value: a.id }, a.name)),
										),
									)
								: null,
							pipeline?.acodec
								? field(
										t("dev.field.audio_codec"),
										m(
											"select",
											{
												value: st.audioCodec,
												onchange: (e: Event) => {
													st.audioCodec = (e.target as HTMLSelectElement).value;
													touched.add("audio-codec");
												},
											},
											m("option", { value: "aac" }, "AAC"),
											m("option", { value: "opus" }, "Opus"),
										),
									)
								: null,
							field(
								t("dev.field.audio_delay"),
								m("input", {
									id: "enc-delay",
									type: "number",
									min: -2000,
									max: 2000,
									placeholder: "0",
									value: st.delay,
									oninput: (e: Event) => (st.delay = (e.target as HTMLInputElement).value),
								}),
							),
							!combined && m("div.break"),
							!combined &&
								field(
									t("dev.field.stream_host"),
									m("input", {
										id: "enc-host",
										placeholder: "192.168.1.10",
										required: true,
										value: st.encHost,
										oninput: (e: Event) => (st.encHost = (e.target as HTMLInputElement).value),
									}),
								),
							!combined &&
								field(
									t("dev.field.stream_srt_port"),
									m("input", {
										id: "enc-port",
										placeholder: "6000",
										required: true,
										value: st.encPort,
										oninput: (e: Event) => (st.encPort = (e.target as HTMLInputElement).value),
									}),
								),
							field(
								t("dev.field.srt_latency"),
								m("input", {
									id: "enc-latency",
									type: "number",
									min: 100,
									max: 10000,
									step: 100,
									placeholder: "2000",
									value: st.latency,
									oninput: (e: Event) => (st.latency = (e.target as HTMLInputElement).value),
								}),
							),
							field(
								t("dev.field.stream_id"),
								m("input", {
									id: "enc-streamid",
									placeholder: t("ui.optional"),
									value: st.streamid,
									oninput: (e: Event) => (st.streamid = (e.target as HTMLInputElement).value),
								}),
							),
							!combined &&
								m("div.break"),
							!combined &&
								m(
									"div.actions",
									m("button", { type: "submit", disabled: !stateButtonEnabled("encoder-start") }, t("ui.start")),
									m(
										"button",
										{
											type: "button",
											class: "danger",
											disabled: !stateButtonEnabled("encoder-stop"),
											onclick: () => void act("encoder-stop", "encoder.stop"),
										},
										t("ui.stop"),
									),
								),
						),
					);
				}
			: null;

		const srtlaCard = hasRelay && status
			? () => {
					const s = status.state.srtla;
					return m(
						Card,
						{ title: t("dev.card.srtla") },
						definitionList([
							[t("dev.row.state"), s.running ? badge(t("dev.row_state_running"), "on") : badge(t("dev.badge.stopped"), "off")],
							//[t("dev.row.target"), srtlaTarget(s, role)],
							[t("dev.row.started"), s.running ? since(s.startedAt) : null],
							[t("dev.reloads"), t("dev.reloads_detail", s.reloadCount ?? 0, since(s.lastReloadAt), status.monitor.reloadMode)],
							[t("dev.monitor"), status.monitor.running ? badge(t("dev.monitor_watching"), "on") : badge(t("ui.off"), "warn")],
							[t("dev.control"), s.running ? controlBadge(status) : null],
						]),
						m(
							"form",
							{ onsubmit: (e: Event) => { e.preventDefault(); void (combined ? encoderStart() : srtlaStart()); } },
							!combined &&
								field(
									t("dev.field.srt_listen_port"),
									m("input", {
										id: "srt-listenPort",
										placeholder: "6000",
										required: true,
										value: st.listenPort,
										oninput: (e: Event) => (st.listenPort = (e.target as HTMLInputElement).value),
									}),
								),
							combined ? "" : " ⇨ ",
							field(
								t("dev.field.remote_host"),
								m("input", {
									id: "srtla-remoteHost",
									placeholder: "rec.example.com",
									required: true,
									value: st.remoteHost,
									oninput: (e: Event) => (st.remoteHost = (e.target as HTMLInputElement).value),
								}),
							),
							field(
								t("dev.field.remote_port"),
								m("input", {
									id: "srtla-remotePort",
									placeholder: "5000",
									required: true,
									value: st.remotePort,
									oninput: (e: Event) => (st.remotePort = (e.target as HTMLInputElement).value),
								}),
							),
							m("div.break"),
							combined
								? m(
										"div.actions",
										m("button", { type: "submit", disabled: !stateButtonEnabled("encoder-start") }, t("ui.start")),
										m(
											"button",
											{ type: "button", class: "danger", disabled: !stateButtonEnabled("encoder-stop"), onclick: () => void act("encoder-stop", "stream.stop") },
											t("ui.stop"),
										),
									)
								: m(
										"div.actions",
										m("button", { type: "submit", disabled: !stateButtonEnabled("srtla-start") }, t("ui.start")),
										m("button", { type: "button", class: "danger", disabled: !stateButtonEnabled("srtla-stop"), onclick: () => void act("srtla-stop", "srtla.stop") }, t("ui.stop")),
										m("button", { type: "button", disabled: !stateButtonEnabled("srtla-reload"), onclick: () => void act("srtla-reload", "srtla.reload") }, t("ui.reload")),
									),
						),
						m(
							"form",
							{ class: "inline options", onsubmit: (e: Event) => e.preventDefault() },
							field(
								t("dev.scheduler"),
								m(
									"select",
									{
										disabled: busy.has("srtla-mode"),
										value: srtlaModeValue(),
										onchange: (e: Event) => void setSrtlaOption("mode", (e.target as HTMLSelectElement).value),
									},
									m("option", { value: "enhanced" }, t("dev.scheduler_enhanced")),
									m("option", { value: "classic" }, t("dev.scheduler_classic")),
								),
							),
							checkField(
								t("dev.quality_scoring"),
								m("input", {
									type: "checkbox",
									checked: srtlaQualityValue(),
									disabled: busy.has("srtla-quality") || srtlaModeValue() === "classic",
									onchange: (e: Event) => void setSrtlaOption("quality", (e.target as HTMLInputElement).checked),
								}),
								{ title: t("dev.quality_scoring_title") },
							),
						),
					);
				}
			: null;

		const interfacesCard = hasRelay && status
			? () => {
					const selected = new Set(status.selected.map((i) => i.iface));
					const live = st.stats;
					const stale = !!st.statsAt && Date.now() - st.statsAt > STATS_STALE_MS;
					const links = new Map((live?.links ?? []).map((l) => [l.ip, l]));
					const total = live ? live.links.reduce((sum, l) => sum + (l.bitrate_bytes_per_sec || 0), 0) : 0;
					const rows = status.interfaces.map((i) => {
						const sub = [i.cidr, i.modemIndex !== undefined ? t("dev.iface_modem", i.modemIndex) : null].filter(Boolean).join(" · ");
						const network = [i.operatorName, i.accessTech].filter(Boolean).join(" · ");
						return m(
							"tr",
							{ key: i.iface, class: selected.has(i.iface) ? "selected" : "" },
							m(
								"td",
								m("input", {
									type: "checkbox",
									checked: selected.has(i.iface),
									disabled: togglingIfaces.has(i.iface),
									title: t("dev.include_in_bond"),
									onchange: () => void toggleIface(i.iface),
								}),
							),
							m("td", null, i.iface, i.speed ? m("small.muted", ` · ${formatSpeed(i.speed)}`) : null, sub ? m("span.iface-sub.muted", sub) : null),
							m("td", signal(i.signalQuality)),
							m("td", network || "—"),
							...linkCells(links.get(i.ip), total),
						);
					});
					return m(
						Card,
						{
							title: t("dev.card.interfaces"),
							headActions: [
								st.stats && stale && badge(t("dev.stale", since(st.statsAt)), "warn"),
								m("button", { type: "button", disabled: inFlight.has("reconfigure"), onclick: () => void act("reconfigure", "reconfigure") }, t("ui.reconfigure")),
							],
						},
						m(
							"table",
							{ class: live ? "" : "no-stats" },
							m(
								"thead",
								m(
									"tr",
									m("th", t("dev.th.bond")),
									m("th", t("dev.th.interface")),
									m("th", t("dev.signal")),
									m("th", t("dev.th.network")),
									m("th.link-col", t("dev.th.link")),
									m("th.link-col", t("mgmt.th_bitrate")),
									m("th.link-col", "RTT"),
									m("th.link-col", { title: t("dev.th.in_flight_title") }, t("dev.th.in_flight")),
									m("th.link-col", t("dev.th.naks")),
									m("th.link-col", t("dev.th.loss")),
									m("th.link-col", t("dev.th.quality")),
								),
							),
							rows.length ? rows : m("tr", m("td", { colspan: 11, class: "muted" }, t("dev.no_interfaces"))),
						),
					);
				}
			: null;

		return m(
			Page,
			{
				title: [
					st.device ? m("a", { href: "../../", title: t("dev.all_devices_title") }, "←") : null,
					` ${t("dev.title")} `,
					st.device && m("span.muted", st.device.hostname || st.device.id),
				],
				headerRight: [
					m(
						"label.check",
						{ title: t("dev.autostart_title") },
						m("input", {
							type: "checkbox",
							checked: status?.state.autostart ?? false,
							disabled: !status || st.autostartBusy,
							onchange: (e: Event) => void setAutostart((e.target as HTMLInputElement).checked),
						}),
						` ${t("ui.autostart")}`,
					),
					status && m("span.badge", roleTag(role)),
					connBadge(),
					m(
						"a.icon-link",
						{ href: "settings/", title: t("set.title"), "aria-label": t("set.title") },
						m("svg",
							{ "aria-hidden": "true", viewBox: "0 0 24 24", width: "18", height: "18", fill: "none", stroke: "currentColor", "stroke-width": "2" },
							m("circle", { cx: 12, cy: 12, r: 3 }),
							m("path", {
								d: "M19.4 15a1.7 1.7 0 0 0 .3 1.9l.1.1-2.8 2.8-.1-.1a1.7 1.7 0 0 0-1.9-.3 1.7 1.7 0 0 0-1 1.6v.2h-4V21a1.7 1.7 0 0 0-1-1.6 1.7 1.7 0 0 0-1.9.3l-.1.1L4.2 17l.1-.1a1.7 1.7 0 0 0 .3-1.9A1.7 1.7 0 0 0 3 14H2.8v-4H3a1.7 1.7 0 0 0 1.6-1 1.7 1.7 0 0 0-.3-1.9L4.2 7 7 4.2l.1.1A1.7 1.7 0 0 0 9 4.6a1.7 1.7 0 0 0 1-1.6v-.2h4V3a1.7 1.7 0 0 0 1 1.6 1.7 1.7 0 0 0 1.9-.3l.1-.1L19.8 7l-.1.1a1.7 1.7 0 0 0-.3 1.9 1.7 1.7 0 0 0 1.6 1h.2v4H21a1.7 1.7 0 0 0-1.6 1Z",
							}),
						),
					),
				],
			},
			encoderCard ? encoderCard() : null,
			srtlaCard ? srtlaCard() : null,
			interfacesCard ? interfacesCard() : null,
			status &&
				hasRelay &&
				m(
					Card,
					{ title: t("dev.card.modems") },
					status.modems.length
						? m("div.grid", status.modems.map(modemCard))
					: m("p.muted", t("dev.no_modems")),
				),
			m(
				Card,
				{ title: t("dev.card.log") },
				m("code", { id: "log" }, logRowsSorted().map((e) =>
					m(
						"li",
						{ key: logKey(e), class: `log-${e.level}` },
						levelIcon(e.level),
						formatLogTime(e.at),
						m("span.log-level", t(LEVEL_KEY[e.level])),
						m("span.log-section", label(e.section)),
						m("span.log-message", e.message),
						m("span.log-count", (e.count ?? 1) > 1 ? `×${e.count}` : null),
					),
				)),
			),
		);
	},
};

// Refresh relative times ("12s ago") and stats staleness without waiting for a push
setInterval(() => {
	if (st.lastStatus || st.stats) m.redraw();
}, 5_000);

m.mount(byId("app"), App);
