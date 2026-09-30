/* Device page — a fully Mithril view. The whole page (header, cards, forms, log) is a
 * component tree over one state object; the WebSocket client mutates state and redraws. */
import m from "mithril";
import { Card, Page, badge, definitionList, field, checkField } from "./components/ui";
import { byId, type Child, formatBitrate, since } from "./dom";
import { type Level, levelIcon, roleTag } from "./icons";
import { type LogEntry, type LogEvent, methodLog } from "../../src/logMessages";
import type { ModemInfo } from "../../src/modems";
import type { DeviceInfo, Pipeline, Role, SrtlaLinkStats, SrtlaStats, SrtlaStatsEvent, Status } from "../types";
import { RpcClient, RpcError, socketUrl } from "./services/rpc";
import type { Params } from "./services/rpc";

const STATS_STALE_MS = 5_000;
const LEVEL_LABEL: Record<Level, string> = { info: "INFO", warn: "WARNING", error: "ERROR" };
const LOG_MAX = 200;

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
	maxBitrate: "",
	latency: "",
	delay: "",
	streamid: "",
	encHost: "",
	encPort: "",
	audioSource: "",
	audioCodec: "aac",
	bitrateOverlay: false,
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
const rpc = new RpcClient(() => socketUrl("ws")); // relative to the page, works at / and /d/<id>/

/** Start / Stop style buttons, enabled only when the streaming state allows their action. */
const STATE_BUTTONS: Record<string, (s: Status) => boolean> = {
	"encoder-start": (s) => !s.state.encoder.running,
	"encoder-stop": (s) => s.state.encoder.running || (s.role === "combined" && s.state.srtla.running),
	"encoder-bitrate": (s) => s.state.encoder.running,
	"srtla-start": (s) => !s.state.srtla.running,
	"srtla-stop": (s) => s.state.srtla.running,
	"srtla-reload": (s) => s.state.srtla.running,
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
			log("error", section, `${action} failed: ${err instanceof Error ? err.message : String(err)}`);
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
	document.title = `${info.id} - Belabox Duo`;
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
	if (st.connectionLost) log("info", "Connection", "Reconnected");
	st.connectionLost = false;
	m.redraw();
});
rpc.on("close", () => {
	// Only once per outage, not on every reconnect attempt
	if (st.socketOpen) {
		st.connectionLost = true;
		log("warn", "Connection", "Lost, reconnecting…");
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

/** Fill empty, unfocused inputs from the device's last known settings. */
function prefill(id: string, target: { value: string }, value: string | number | undefined): void {
	if (target.value || document.activeElement?.id === id || value === undefined || value === "" || value == null) return;
	target.value = String(value);
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
			const value = s[key] ?? status.state.srtlaTarget?.[key];
			if (value !== undefined) prefill(`srtla-${key}`, { value: st[key] }, value as string | number);
		}
	} else {
		prefill("srtla-listenPort", { value: st.listenPort }, s.listenPort);
		prefill("srtla-remoteHost", { value: st.remoteHost }, s.remoteHost);
		prefill("srtla-remotePort", { value: st.remotePort }, s.remotePort);
	}
	if (status.role === "relay") return;

	const cfg = status.state.encoder.config;
	if (cfg && !combined) {
		prefill("enc-host", { value: st.encHost }, cfg.host);
		prefill("enc-port", { value: st.encPort }, cfg.port);
	}
	prefill("enc-maxBitrate", { value: st.maxBitrate }, cfg?.maxBitrate);
	prefill("enc-latency", { value: st.latency }, cfg?.latency);
	prefill("enc-delay", { value: st.delay }, cfg?.delay);
	prefill("enc-streamid", { value: st.streamid }, cfg?.streamid);

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
	if (method === "modems.reset" && !confirm(`Reset modem #${index}?`)) return;
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
		? ["disconnected", "off"]
		: st.device && !st.device.online
			? ["device offline", "warn"]
			: ["connected", "on"];
	return badge(text, kind);
}

function srtlaTarget(s: Status["state"]["srtla"], role: Role): Child {
	if (!s.remoteHost) return null;
	// On combined devices the listen port is an internal belacoder → srtla_send detail
	return `${s.remoteHost}:${s.remotePort}${role === "combined" ? "" : ` (listen ${s.listenPort})`}`;
}

function controlBadge(status: Status): Child {
	const c = status.srtlaControl;
	if (c?.connected) return badge("connected", "on");
	if (c?.supported) return badge("connecting", "warn");
	return m(
		"span.muted",
		{ title: "srtla_send without --control-socket: no link stats" },
		"unavailable",
	);
}

function linkState(l: SrtlaLinkStats): m.Vnode {
	if (l.timed_out) return badge("timed out", "off");
	if (!l.connected) return badge("connecting", "warn");
	if (l.stall_gated) return badge("stalled", "warn");
	if (l.weak) return m("span", { title: l.weak_reason ?? "" }, badge("weak", "warn"));
	return badge(l.sole_carrier ? "sole carrier" : "up", "on");
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
				m("meter.share", { min: 0, max: 1, value: share, title: `${Math.round(share * 100)}% of total` }),
				formatBitrate(l.bitrate_bytes_per_sec),
			),
			"num",
		),
		cell(l.connected ? `${Math.round(l.rtt_ms)} ms` : "—", "num", `min ${Math.round(l.rtt_min_ms)} ms`),
		cell(`${l.in_flight} / ${l.window}`, "num"),
		cell(l.nak_count, "num"),
		cell(`${((l.cc_loss_permille ?? 0) / 10).toFixed(1)}%`, "num"),
		cell(
			l.quality_multiplier !== undefined ? `×${l.quality_multiplier.toFixed(2)}` : "—",
			"num",
			l.base_score !== undefined ? `score ${l.base_score}` : "",
		),
	];
}

const formatSpeed = (mbps: number) => (mbps >= 1000 ? `${mbps / 1000} Gb/s` : `${mbps} Mb/s`);

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
	if (!nodes.length) nodes.push(m("option", { value: "", disabled: true }, `No pipelines in ${st.pipelineDir}`));
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
			m("span", `#${modem.index} ${[modem.manufacturer, modem.model].filter(Boolean).join(" ") || "Modem"}`),
			badge(modem.state, connected ? "on" : modem.state === "disabled" || modem.state === "failed" ? "off" : "warn"),
		),
		definitionList([
			["Signal", signal(modem.signalQuality)],
			["Operator", modem.operatorName],
			["Tech", modem.accessTech],
			["Registration", modem.registrationState],
			["Power", modem.powerState],
			["IMEI", modem.imei],
		]),
		m(
			"div.actions",
			button("Enable", "modems.enable"),
			button("Disable", "modems.disable"),
			connected ? button("Disconnect", "modems.disconnect") : button("Connect", "modems.connect"),
			button("Reset", "modems.reset", "danger"),
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
						? badge("stopped", "off")
						: combined && !srtla.running
							? badge("srtla_send down", "warn")
							: e.pid || !e.restarts
								? badge("streaming", "on")
								: badge("restarting", "warn");
					const target = combined
						? srtla.remoteHost && `${srtla.remoteHost}:${srtla.remotePort} via srtla_send`
						: cfg && `${cfg.host}:${cfg.port}`;
					const pipeline = selectedPipeline();
					const asrc = status.audioSources.find((a) => a.id === st.audioSource);
					return m(
						Card,
						{ title: "Encoder" },
						definitionList([
							["State", state],
							["Pipeline", cfg?.pipeline],
							["Target", e.running ? target : null],
							["Bitrate", cfg ? `max ${cfg.maxBitrate} kbps` : null],
							["Latency", cfg ? `${cfg.latency} ms (audio delay ${cfg.delay} ms)` : null],
							["Audio", cfg ? `${asrc?.name ?? cfg.audioSource ?? "Pipeline default"}, ${(cfg.audioCodec ?? "aac").toUpperCase()}` : null],
							["Started", e.running ? since(e.startedAt) : null],
							["Restarts", e.running ? (e.restarts ?? 0) : null],
						]),
						m(
							"form",
							{ onsubmit: (e: Event) => { e.preventDefault(); void encoderStart(); } },
							field(
								"Pipeline",
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
								"Max bitrate (kbps)",
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
							),
							pipeline?.overlay
								? checkField(
										"Bitrate overlay",
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
							m("div.break"),
							pipeline?.asrc
								? field(
										"Audio source",
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
										"Audio codec",
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
								"Audio delay (ms)",
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
									"Relay host",
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
									"Relay SRT port",
									m("input", {
										id: "enc-port",
										placeholder: "6000",
										required: true,
										value: st.encPort,
										oninput: (e: Event) => (st.encPort = (e.target as HTMLInputElement).value),
									}),
								),
							field(
								"SRT latency (ms)",
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
								"Stream ID",
								m("input", {
									id: "enc-streamid",
									placeholder: "optional",
									value: st.streamid,
									oninput: (e: Event) => (st.streamid = (e.target as HTMLInputElement).value),
								}),
							),
							m(
								"div.actions",
								m("button", { type: "submit", disabled: !stateButtonEnabled("encoder-start") }, "Start"),
								m(
									"button",
									{
										type: "button",
										class: "danger",
										disabled: !stateButtonEnabled("encoder-stop"),
										onclick: () => void act("encoder-stop", role === "combined" ? "stream.stop" : "encoder.stop"),
									},
									"Stop",
								),
								m(
									"button",
									{
										type: "button",
										class: "secondary",
										disabled: !stateButtonEnabled("encoder-bitrate"),
										onclick: () => void act("encoder-bitrate", "encoder.bitrate", { maxBitrate: optionalNumber(st.maxBitrate) }),
									},
									"Apply bitrate",
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
						{ title: "SRTLA" },
						definitionList([
							["State", s.running ? badge("running", "on") : badge("stopped", "off")],
							["Target", srtlaTarget(s, role)],
							["Started", s.running ? since(s.startedAt) : null],
							["Reloads", `${s.reloadCount ?? 0} (last ${since(s.lastReloadAt)}, mode ${status.monitor.reloadMode})`],
							["Monitor", status.monitor.running ? badge("watching", "on") : badge("off", "warn")],
							["Control", s.running ? controlBadge(status) : null],
						]),
						m(
							"form",
							{ onsubmit: (e: Event) => { e.preventDefault(); void srtlaStart(); } },
							!combined &&
								field(
									"SRT Listen port",
									m("input", {
										id: "srtla-listenPort",
										placeholder: "6000",
										required: true,
										value: st.listenPort,
										oninput: (e: Event) => (st.listenPort = (e.target as HTMLInputElement).value),
									}),
								),
							combined && " ⇨ ",
							field(
								"SRTLA Remote host",
								m("input", {
									id: "srtla-remoteHost",
									placeholder: "rec.example.com",
									required: true,
									value: st.remoteHost,
									oninput: (e: Event) => (st.remoteHost = (e.target as HTMLInputElement).value),
								}),
							),
							field(
								"SRTLA Remote port",
								m("input", {
									id: "srtla-remotePort",
									placeholder: "5000",
									required: true,
									value: st.remotePort,
									oninput: (e: Event) => (st.remotePort = (e.target as HTMLInputElement).value),
								}),
							),
							!combined &&
								m(
									"div.actions",
									m("button", { type: "submit", disabled: !stateButtonEnabled("srtla-start") }, "Start"),
									m("button", { type: "button", class: "danger", disabled: !stateButtonEnabled("srtla-stop"), onclick: () => void act("srtla-stop", "srtla.stop") }, "Stop"),
									m("button", { type: "button", disabled: !stateButtonEnabled("srtla-reload"), onclick: () => void act("srtla-reload", "srtla.reload") }, "Reload"),
								),
						),
						m(
							"form",
							{ class: "inline options", onsubmit: (e: Event) => e.preventDefault() },
							field(
								"Scheduler",
								m(
									"select",
									{
										disabled: busy.has("srtla-mode"),
										value: srtlaModeValue(),
										onchange: (e: Event) => void setSrtlaOption("mode", (e.target as HTMLSelectElement).value),
									},
									m("option", { value: "enhanced" }, "Enhanced"),
									m("option", { value: "classic" }, "Classic"),
								),
							),
							checkField(
								"Quality scoring",
								m("input", {
									type: "checkbox",
									checked: srtlaQualityValue(),
									disabled: busy.has("srtla-quality") || srtlaModeValue() === "classic",
									onchange: (e: Event) => void setSrtlaOption("quality", (e.target as HTMLInputElement).checked),
								}),
								{ title: "Score links by RTT, loss and NAKs (enhanced scheduler only)" },
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
						const sub = [i.cidr, i.modemIndex !== undefined ? `modem #${i.modemIndex}` : null].filter(Boolean).join(" · ");
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
									title: "Include in bond",
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
							title: "Interfaces",
							headActions: [
								st.stats && stale && badge(`stale, ${since(st.statsAt)}`, "warn"),
								m("button", { type: "button", disabled: inFlight.has("reconfigure"), onclick: () => void act("reconfigure", "reconfigure") }, "Reconfigure"),
							],
						},
						m(
							"table",
							{ class: live ? "" : "no-stats" },
							m(
								"thead",
								m(
									"tr",
									m("th", "Bond"),
									m("th", "Interface"),
									m("th", "Signal"),
									m("th", "Network"),
									m("th.link-col", "Link"),
									m("th.link-col", "Bitrate"),
									m("th.link-col", "RTT"),
									m("th.link-col", { title: "Packets in flight / congestion window" }, "In flight"),
									m("th.link-col", "NAKs"),
									m("th.link-col", "Loss"),
									m("th.link-col", "Quality"),
								),
							),
							rows.length ? rows : m("tr", m("td", { colspan: 11, class: "muted" }, "No interfaces detected")),
						),
					);
				}
			: null;

		return m(
			Page,
			{
				title: [
					st.device ? m("a", { href: "../../", title: "All devices" }, "←") : null,
					" Belabox Duo ",
					st.device && m("span.muted", st.device.id),
				],
				headerRight: [
					m(
						"label.check",
						{ title: "Resume the last stream when the service starts" },
						m("input", {
							type: "checkbox",
							checked: status?.state.autostart ?? false,
							disabled: !status || st.autostartBusy,
							onchange: (e: Event) => void setAutostart((e.target as HTMLInputElement).checked),
						}),
						" Autostart",
					),
					status && m("span.badge", roleTag(role)),
					connBadge(),
					m(
						"a.icon-link",
						{ href: "settings/", title: "Settings", "aria-label": "Settings" },
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
					{ title: "Modems" },
					status.modems.length
						? m("div.grid", status.modems.map(modemCard))
						: m("p.muted", "No modems found (ModemManager)."),
				),
			m(
				Card,
				{ title: "Log" },
				m("code", { id: "log" }, logRowsSorted().map((e) =>
					m(
						"li",
						{ key: logKey(e), class: `log-${e.level}` },
						levelIcon(e.level),
						formatLogTime(e.at),
						m("span.log-level", LEVEL_LABEL[e.level]),
						m("span.log-section", e.section),
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
