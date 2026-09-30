/* Device page (relay UI). The static HTML holds the form skeletons; Mithril renders every
 * dynamic region (badges, tables, log) into those skeletons, and the WebSocket just mutates
 * state and redraws. */
import m from "mithril";
import { badge, byId, definitionList, definitionRows, type Child, formatBitrate, since } from "./dom";
import { type Level, levelIcon, roleTag } from "./icons";
import { type LogEntry, type LogEvent, methodLog } from "../../src/logMessages";
import type { ModemInfo } from "../../src/modems";
import type { DeviceInfo, Pipeline, Role, SrtlaLinkStats, SrtlaStats, SrtlaStatsEvent, Status } from "../types";

type Params = Record<string, unknown>;

const CALL_TIMEOUT_MS = 30_000;
const RECONNECT_MS = 2_000;
const STATS_STALE_MS = 5_000;

const LEVEL_LABEL: Record<Level, string> = { info: "INFO", warn: "WARNING", error: "ERROR" };
const LOG_MAX = 200;

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

function renderLog(): void {
	const rows = [...logRows.values()].sort((a, b) => b.at - a.at || b.id - a.id);
	for (const old of rows.splice(LOG_MAX)) logRows.delete(logKey(old));
	m.render(
		byId("log"),
		rows.map((e) =>
			m(
				"li",
				{ class: `log-${e.level}` },
				levelIcon(e.level),
				formatLogTime(e.at),
				m("span.log-level", LEVEL_LABEL[e.level]),
				m("span.log-section", e.section),
				m("span.log-message", e.message),
				m("span.log-count", (e.count ?? 1) > 1 ? `×${e.count}` : null),
			),
		),
	);
}

function applyLog(data: LogEvent): void {
	if (data.reset) {
		for (const [key, e] of logRows) if (e.origin !== "browser") logRows.delete(key);
	}
	for (const e of data.entries) logRows.set(logKey(e), e);
	renderLog();
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
	renderLog();
}

// ----------------------------------------------------------------------
// WebSocket client
// ----------------------------------------------------------------------
let ws: WebSocket | null = null;
let nextId = 1;
const pending = new Map<number, { resolve: (v: unknown) => void; reject: (e: Error) => void }>();

let socketOpen = false;
let connectionLost = false;
let device: DeviceInfo | null = null; // null = talking to the relay directly

function updateConnBadge(): void {
	const el = byId("conn");
	const [text, kind] = !socketOpen
		? ["disconnected", "off"]
		: device && !device.online
			? ["device offline", "warn"]
			: ["connected", "on"];
	el.textContent = text;
	el.className = `badge ${kind}`;
}

function setConnected(connected: boolean): void {
	socketOpen = connected;
	updateConnBadge();
}

function renderDevice(info: DeviceInfo): void {
	const wasOnline = device?.online;
	device = info;
	byId("device-name").textContent = info.id;
	byId("back").hidden = false;
	document.title = `${info.id} - Belabox Duo`;
	if (wasOnline !== undefined && wasOnline !== info.online && info.online) pipelinesLoaded = false;
	if (!info.online) setStats(null);
	updateConnBadge();
}

function connect(): void {
	// Relative to the page, so the same UI works at `/` (relay) and `/d/<id>/` (control server)
	const url = new URL("ws", location.href);
	url.protocol = location.protocol === "https:" ? "wss:" : "ws:";
	ws = new WebSocket(url);

	ws.onopen = () => {
		setConnected(true);
		pipelinesLoaded = false;
		void loadAppearance();
		if (connectionLost) log("info", "Connection", "Reconnected");
		connectionLost = false;
	};

	ws.onclose = () => {
		// Only once per outage, not on every reconnect attempt
		if (socketOpen) {
			connectionLost = true;
			log("warn", "Connection", "Lost, reconnecting…");
		}

		setConnected(false);
		setStats(null);
		for (const p of pending.values()) p.reject(new Error("connection closed"));
		pending.clear();
		setTimeout(connect, RECONNECT_MS);
	};

	ws.onmessage = (e) => {
		const msg = JSON.parse(String(e.data));
		if (msg.type === "event" && msg.event === "status") {
			renderStatus(msg.data as Status);
		} else if (msg.type === "event" && msg.event === "srtla.stats") {
			setStats((msg.data as SrtlaStatsEvent).stats);
		} else if (msg.type === "event" && msg.event === "device") {
			renderDevice(msg.data as DeviceInfo);
		} else if (msg.type === "event" && msg.event === "log") {
			applyLog(msg.data as LogEvent);
		} else if (msg.type === "response") {
			const p = pending.get(msg.id);
			if (!p) return;
			pending.delete(msg.id);
			if (msg.ok) p.resolve(msg.result);
			// `logged`: the device already recorded the failure in its event log
			else p.reject(Object.assign(new Error(msg.error), { logged: !!msg.logged }));
		}
	};
}

async function loadAppearance(): Promise<void> {
	const result = await call<{ settings: { color: string } }>("settings.get").catch(() => null);
	if (result) document.documentElement.style.setProperty("--header-color", result.settings.color);
}

function call<T = unknown>(method: string, params?: Params): Promise<T> {
	return new Promise((resolve, reject) => {
		if (!ws || ws.readyState !== WebSocket.OPEN) {
			reject(new Error("not connected"));
			return;
		}
		const id = nextId++;
		const timer = setTimeout(() => {
			pending.delete(id);
			reject(new Error(`${method} timed out`));
		}, CALL_TIMEOUT_MS);
		pending.set(id, {
			resolve: (v) => {
				clearTimeout(timer);
				resolve(v as T);
			},
			reject: (e) => {
				clearTimeout(timer);
				reject(e);
			},
		});
		ws.send(JSON.stringify({ id, method, params }));
	});
}

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
const inFlight = new Set<string>();
const awaitingStatus = new Set<string>();

function updateStateButtons(): void {
	for (const id of Object.keys(STATE_BUTTONS)) {
		const b = byId<HTMLButtonElement>(id);
		b.disabled = inFlight.has(id) || awaitingStatus.has(id) || !lastStatus || !STATE_BUTTONS[id](lastStatus);
	}
}

/** Run a method with its button disabled while in flight; logs failures the device did not. */
async function act<T = unknown>(
	buttonId: string | null,
	method: string,
	params?: Params,
): Promise<T | undefined> {
	if (buttonId) {
		inFlight.add(buttonId);
		byId<HTMLButtonElement>(buttonId).disabled = true;
	}
	let ok = false;
	try {
		const result = await call<T>(method, params);
		ok = true;
		return result;
	} catch (err) {
		if (!(err as { logged?: boolean }).logged) {
			const { section, action } = methodLog(method);
			log("error", section, `${action} failed: ${err instanceof Error ? err.message : String(err)}`);
		}
		return undefined;
	} finally {
		if (buttonId) {
			inFlight.delete(buttonId);
			if (!(buttonId in STATE_BUTTONS)) byId<HTMLButtonElement>(buttonId).disabled = false;
			else {
				if (ok) {
					awaitingStatus.add(buttonId);
					setTimeout(() => {
						awaitingStatus.delete(buttonId);
						updateStateButtons();
					}, AWAIT_STATUS_MS);
				}
				updateStateButtons();
			}
		}
	}
}

// ----------------------------------------------------------------------
// SRTLA
// ----------------------------------------------------------------------
function srtlaTarget(s: Status["state"]["srtla"]): Child {
	if (!s.remoteHost) return null;
	// On combined devices the listen port is an internal belacoder → srtla_send detail
	return `${s.remoteHost}:${s.remotePort}${role === "combined" ? "" : ` (listen ${s.listenPort})`}`;
}

function controlBadge(status: Status): Child {
	const c = status.srtlaControl;
	if (c?.connected) return badge("connected", "on");
	if (c?.supported) return badge("connecting", "warn");
	return m(
		"span",
		{ class: "muted", title: "srtla_send without --control-socket: no link stats" },
		"unavailable",
	);
}

function renderSrtla(status: Status): void {
	const s = status.state.srtla;
	definitionList(byId("srtla-info"), [
		["State", s.running ? badge("running", "on") : badge("stopped", "off")],
		["Target", srtlaTarget(s)],
		["Started", s.running ? since(s.startedAt) : null],
		["Reloads", `${s.reloadCount ?? 0} (last ${since(s.lastReloadAt)}, mode ${status.monitor.reloadMode})`],
		["Monitor", status.monitor.running ? badge("watching", "on") : badge("off", "warn")],
		["Control", s.running ? controlBadge(status) : null],
	]);

	renderSrtlaOptions(status);

	// Prefill the form from the last known target without clobbering user input
	const form = byId<HTMLFormElement>("srtla-form");
	for (const key of ["listenPort", "remoteHost", "remotePort"] as const) {
		const input = form.elements.namedItem(key) as HTMLInputElement;
		const value = s[key] ?? status.state.srtlaTarget?.[key];
		if (!input.value && document.activeElement !== input && value) input.value = value;
	}
}

/** Scheduler controls: the saved settings, else what the running srtla_send reports, else its defaults. */
function renderSrtlaOptions(status: Status): void {
	const opts = status.state.srtlaOptions ?? {};
	const live = status.state.srtla.running ? stats : null;
	const mode = opts.mode ?? live?.mode ?? "enhanced";
	const modeSelect = byId<HTMLSelectElement>("srtla-mode");
	const quality = byId<HTMLInputElement>("srtla-quality");
	if (!modeSelect.disabled && document.activeElement !== modeSelect) modeSelect.value = mode;
	if (!datasetBusy(quality)) {
		quality.checked = opts.quality ?? live?.quality_enabled ?? true;
		quality.disabled = mode === "classic";
	}
}

const datasetBusy = (el: HTMLElement) => el.dataset.busy === "1";

// ----------------------------------------------------------------------
// srtla_send link stats (pushed ~1 Hz over the control socket)
// ----------------------------------------------------------------------
let stats: SrtlaStats | null = null;
let statsAt = 0;

function setStats(next: SrtlaStats | null): void {
	stats = next;
	statsAt = next ? Date.now() : 0;
	renderStats();
	if (lastStatus && role !== "encoder") renderSrtlaOptions(lastStatus);
}

function linkState(l: SrtlaLinkStats): Child {
	if (l.timed_out) return badge("timed out", "off");
	if (!l.connected) return badge("connecting", "warn");
	if (l.stall_gated) return badge("stalled", "warn");
	if (l.weak) return m("span", { title: l.weak_reason ?? "" }, badge("weak", "warn"));
	return badge(l.sole_carrier ? "sole carrier" : "up", "on");
}

/** Re-render the interfaces card when fresh link stats arrive. */
function renderStats(): void {
	if (lastStatus && role !== "encoder") renderInterfaces(lastStatus);
}

function renderStatsAge(): void {
	const age = byId("links-age");
	age.hidden = !stats;
	const stale = !!statsAt && Date.now() - statsAt > STATS_STALE_MS;
	m.render(age, stale ? badge(`stale, ${since(statsAt)}`, "warn") : []);
}

/** Link columns for an interface; srtla_send links are matched to interfaces by source IP. */
function linkCells(l: SrtlaLinkStats | undefined, total: number): m.Vnode[] {
	const cell = (child: Child, cls = "", title?: string): m.Vnode =>
		m("td", { class: `link-col ${cls}`.trim(), title }, child);
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

/** Interfaces being toggled; kept across the ~1 Hz stats re-renders. */
const togglingIfaces = new Set<string>();

const formatSpeed = (mbps: number) => (mbps >= 1000 ? `${mbps / 1000} Gb/s` : `${mbps} Mb/s`);

function renderInterfaces(status: Status): void {
	const selected = new Set(status.selected.map((i) => i.iface));

	const live = stats;
	byId("iface-table").classList.toggle("no-stats", !live);
	renderStatsAge();

	const links = new Map((live?.links ?? []).map((l) => [l.ip, l]));
	const total = live ? live.links.reduce((sum, l) => sum + (l.bitrate_bytes_per_sec || 0), 0) : 0;

	const rows = status.interfaces.map((i) => {
		const sub = [i.cidr, i.modemIndex !== undefined ? `modem #${i.modemIndex}` : null].filter(Boolean).join(" · ");
		const network = [i.operatorName, i.accessTech].filter(Boolean).join(" · ");
		return m(
			"tr",
			{ class: selected.has(i.iface) ? "selected" : "" },
			m(
				"td",
				m("input", {
					id: `iface-check-${i.iface}`,
					type: "checkbox",
					checked: selected.has(i.iface),
					disabled: togglingIfaces.has(i.iface),
					title: "Include in bond",
					onchange: () => void toggleIface(i, byId<HTMLInputElement>(`iface-check-${i.iface}`)),
				}),
			),
			m(
				"td",
				null,
				i.iface,
				i.speed ? m("small.muted", ` · ${formatSpeed(i.speed)}`) : null,
				sub ? m("span.iface-sub.muted", sub) : null,
			),
			m("td", signal(i.signalQuality)),
			m("td", network || "—"),
			...linkCells(links.get(i.ip), total),
		);
	});
	m.render(
		byId("iface-rows"),
		rows.length ? rows : [m("tr", m("td", { colspan: 11, class: "muted" }, "No interfaces detected"))],
	);
}

/** Bond checkbox toggle; the checkbox stays disabled until the action round-trips. */
async function toggleIface(i: { iface: string }, box: HTMLInputElement): Promise<void> {
	togglingIfaces.add(i.iface);
	box.disabled = true;
	await act(null, "modems.toggle", { iface: i.iface });
	togglingIfaces.delete(i.iface);
	if (lastStatus && role !== "encoder") renderInterfaces(lastStatus);
}

function signal(quality?: number): Child {
	if (quality === undefined) return "—";
	return m("span", null, m("meter", { min: 0, max: 100, low: 30, high: 60, optimum: 100, value: quality }), ` ${quality}%`);
}

// ----------------------------------------------------------------------
// Modems
// ----------------------------------------------------------------------
function modemButton(label: string, method: string, index: number, className = "secondary"): m.Vnode {
	return m("button", {
		type: "button",
		class: className,
		onclick: (e: Event) => {
			if (method === "modems.reset" && !confirm(`Reset modem #${index}?`)) return;
			const btn = e.currentTarget as HTMLButtonElement;
			btn.disabled = true;
			void act(null, method, { index }).finally(() => {
				btn.disabled = false;
			});
		},
	}, label);
}

function renderModems(modems: ModemInfo[]): void {
	const cards = modems.map((modem) => {
		const connected = modem.state === "connected";
		return m(
			"article.modem",
			null,
			m(
				"h3",
				`#${modem.index} ${[modem.manufacturer, modem.model].filter(Boolean).join(" ") || "Modem"}`,
				badge(modem.state, connected ? "on" : modem.state === "disabled" || modem.state === "failed" ? "off" : "warn"),
			),
			m("dl", definitionRows([
				["Signal", signal(modem.signalQuality)],
				["Operator", modem.operatorName],
				["Tech", modem.accessTech],
				["Registration", modem.registrationState],
				["Power", modem.powerState],
				["IMEI", modem.imei],
			])),
			m(
				"div.actions",
				modemButton("Enable", "modems.enable", modem.index),
				modemButton("Disable", "modems.disable", modem.index),
				connected
					? modemButton("Disconnect", "modems.disconnect", modem.index)
					: modemButton("Connect", "modems.connect", modem.index),
				modemButton("Reset", "modems.reset", modem.index, "danger"),
			),
		);
	});
	m.render(byId("modem-list"), cards.length ? cards : [m("p.muted", "No modems found (ModemManager).")]);
}

// ----------------------------------------------------------------------
// Encoder (encoder and combined roles)
// ----------------------------------------------------------------------
let pipelinesLoaded = false;
let role: Role = "relay";
const pipelines = new Map<string, Pipeline>();

/** Show only the audio / overlay options the selected pipeline supports. */
function updatePipelineFields(): void {
	const p = pipelines.get(byId<HTMLSelectElement>("pipeline").value);
	byId("asrc-field").hidden = !p?.asrc;
	byId("acodec-field").hidden = !p?.acodec;
	byId("overlay-field").hidden = !p?.overlay;
}

// Selects always have a value, so remember which ones the user changed to avoid clobbering them
const touched = new Set<string>();
function prefillSelect(id: string, value: string | undefined): void {
	const select = byId<HTMLSelectElement>(id);
	if (touched.has(id) || value === undefined || document.activeElement === select) return;
	if ([...select.options].some((o) => o.value === value)) select.value = value;
}

async function loadPipelines(): Promise<void> {
	pipelinesLoaded = true;
	const result = await act<{ dir: string; pipelines: Pipeline[] } | null>(null, "pipelines.list");
	if (!result) {
		pipelinesLoaded = false;
		return;
	}
	const select = byId<HTMLSelectElement>("pipeline");
	const current = select.value || lastStatus?.state.encoder.config?.pipeline || "";
	pipelines.clear();
	for (const p of result.pipelines) pipelines.set(p.id, p);
	const groups = new Map<string, Pipeline[]>();
	for (const p of result.pipelines) groups.set(p.group, [...(groups.get(p.group) ?? []), p]);
	const nodes: m.Vnode[] = [];
	for (const [group, list] of groups) {
		const options = list.map((p) => m("option", { value: p.id }, p.name));
		if (group) nodes.push(m("optgroup", { label: group }, options));
		else nodes.push(...options);
	}
	if (!nodes.length) nodes.push(m("option", { value: "", disabled: true }, `No pipelines in ${result.dir}`));
	m.render(select, nodes);
	if (result.pipelines.some((p) => p.id === current)) select.value = current;
	updatePipelineFields();
}

/** Fill empty, unfocused inputs from the device's last known settings. */
function prefill(form: HTMLFormElement, values: Record<string, string | number | undefined>): void {
	for (const [key, value] of Object.entries(values)) {
		const input = form.elements.namedItem(key) as HTMLInputElement | null;
		if (input && !input.value && document.activeElement !== input && value !== undefined && value !== "") {
			input.value = String(value);
		}
	}
}

function renderEncoder(status: Status): void {
	const combined = status.role === "combined";
	const e = status.state.encoder;
	const cfg = e.config;
	const srtla = status.state.srtla;

	byId("encoder-title").textContent = "Encoder";

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

	definitionList(byId("encoder-info"), [
		["State", state],
		["Pipeline", cfg?.pipeline],
		["Target", e.running ? target : null],
		["Bitrate", cfg ? `max ${cfg.maxBitrate} kbps` : null],
		["Latency", cfg ? `${cfg.latency} ms (audio delay ${cfg.delay} ms)` : null],
		[
			"Audio",
			cfg
				? `${status.audioSources.find((a) => a.id === cfg.audioSource)?.name ?? cfg.audioSource ?? "Pipeline default"}, ${(
						cfg.audioCodec ?? "aac"
					).toUpperCase()}`
				: null,
		],
		["Started", e.running ? since(e.startedAt) : null],
		["Restarts", e.running ? (e.restarts ?? 0) : null],
	]);

	const form = byId<HTMLFormElement>("encoder-form");
	prefill(form, {
		// Combined devices take the receiver from the srtla_send card instead
		host: combined ? undefined : cfg?.host,
		port: combined ? undefined : cfg?.port,
		maxBitrate: cfg?.maxBitrate,
		latency: cfg?.latency,
		delay: cfg?.delay,
		streamid: cfg?.streamid,
	});

	// Audio sources change as USB devices come and go; keep the current choice if still present
	const asrc = byId<HTMLSelectElement>("audio-source");
	const chosen = asrc.value;
	m.render(asrc, status.audioSources.map((a) => m("option", { value: a.id }, a.name)));
	if (status.audioSources.some((a) => a.id === chosen)) asrc.value = chosen;
	prefillSelect("audio-source", cfg?.audioSource);
	prefillSelect("audio-codec", cfg?.audioCodec);
	const overlay = byId<HTMLInputElement>("bitrate-overlay");
	if (!touched.has("bitrate-overlay") && cfg) overlay.checked = !!cfg.bitrateOverlay;
}

function setRequired(formId: string, name: string, required: boolean): void {
	(byId<HTMLFormElement>(formId).elements.namedItem(name) as HTMLInputElement).required = required;
}

function applyRole(next: Role): void {
	role = next;
	const hasEncoder = role !== "relay";
	const hasRelay = role !== "encoder";
	const roleBadge = byId("role");
	roleBadge.hidden = false;
	if (roleBadge.dataset.role !== role) {
		roleBadge.dataset.role = role;
		m.render(roleBadge, roleTag(role));
	}
	byId("encoder").hidden = !hasEncoder;
	for (const id of ["srtla", "interfaces", "modems"]) byId(id).hidden = !hasRelay;
	// Combined: the receiver is entered in the srtla_send card, but the stream card's single
	// Start/Stop drives srtla_send, and its local listen port is internal
	const combined = role === "combined";
	byId("srtla-listen-field").hidden = combined;
	byId("srtla-actions").hidden = combined;
	byId("encoder-relay-break").hidden = combined;
	byId("encoder-host-field").hidden = combined;
	byId("encoder-port-field").hidden = combined;
	// Hidden required inputs would block form submission
	setRequired("srtla-form", "listenPort", !combined);
	setRequired("encoder-form", "host", !combined);
	setRequired("encoder-form", "port", !combined);
	if (hasEncoder && !pipelinesLoaded) void loadPipelines();
}

let lastStatus: Status | null = null;

function renderStatus(status: Status): void {
	lastStatus = status;
	const autostart = byId<HTMLInputElement>("autostart");
	if (!autostart.disabled) autostart.checked = !!status.state.autostart;
	applyRole(status.role ?? "relay");
	if (role !== "relay") renderEncoder(status);
	if (role !== "encoder") {
		renderSrtla(status);
		renderInterfaces(status);
		renderModems(status.modems);
	}
	awaitingStatus.clear();
	updateStateButtons();
}

// ----------------------------------------------------------------------
// Static controls (form submission is imperative; Mithril renders the dynamic regions)
// ----------------------------------------------------------------------
byId<HTMLFormElement>("srtla-form").onsubmit = (e) => {
	e.preventDefault();
	// Enter in the receiver fields of a combined device means "start the stream"
	if (role === "combined") {
		byId<HTMLFormElement>("encoder-form").requestSubmit();
		return;
	}
	const button = byId<HTMLButtonElement>("srtla-start");
	if (button.disabled) return;
	const params = Object.fromEntries(new FormData(e.currentTarget as HTMLFormElement));
	void act("srtla-start", "srtla.start", params);
};
byId<HTMLButtonElement>("srtla-stop").onclick = () => void act("srtla-stop", "srtla.stop");
byId<HTMLButtonElement>("srtla-reload").onclick = () => void act("srtla-reload", "srtla.reload");
async function setSrtlaOption(el: HTMLInputElement | HTMLSelectElement, params: Params): Promise<void> {
	el.disabled = true;
	el.dataset.busy = "1";
	const result = await act<{ options: Status["state"]["srtlaOptions"]; applied: boolean } | null>(null, "srtla.options", params);
	el.disabled = false;
	delete el.dataset.busy;
	// The status push is debounced; do not flash the old value until it arrives
	if (result && lastStatus) lastStatus.state.srtlaOptions = result.options;
	if (lastStatus) renderSrtlaOptions(lastStatus);
}
byId<HTMLSelectElement>("srtla-mode").onchange = (e) => {
	const select = e.currentTarget as HTMLSelectElement;
	void setSrtlaOption(select, { mode: select.value });
};
byId<HTMLInputElement>("srtla-quality").onchange = (e) => {
	const box = e.currentTarget as HTMLInputElement;
	void setSrtlaOption(box, { quality: box.checked });
};
byId<HTMLButtonElement>("reconfigure").onclick = () => void act("reconfigure", "reconfigure");

const optionalNumber = (v: FormDataEntryValue | null) => (v === null || v === "" ? undefined : Number(v));

byId<HTMLFormElement>("encoder-form").onsubmit = (e) => {
	e.preventDefault();
	const button = byId<HTMLButtonElement>("encoder-start");
	// Enter in a field (or the combined receiver form) still submits while Start is disabled
	if (button.disabled) return;
	const data = new FormData(e.currentTarget as HTMLFormElement);
	const common = {
		pipeline: data.get("pipeline"),
		maxBitrate: optionalNumber(data.get("maxBitrate")),
		latency: optionalNumber(data.get("latency")),
		delay: optionalNumber(data.get("delay")),
		streamid: data.get("streamid") || undefined,
		// Options the selected pipeline does not support are hidden; do not send their stale values
		audioSource: byId("asrc-field").hidden ? "default" : data.get("audioSource") || undefined,
		audioCodec: byId("acodec-field").hidden ? undefined : data.get("audioCodec") || undefined,
		bitrateOverlay: !byId("overlay-field").hidden && byId<HTMLInputElement>("bitrate-overlay").checked,
	};
	if (role === "combined") {
		const receiver = byId<HTMLFormElement>("srtla-form");
		if (!receiver.reportValidity()) return;
		const r = new FormData(receiver);
		void act("encoder-start", "stream.start", {
			...common,
			remoteHost: r.get("remoteHost"),
			remotePort: r.get("remotePort"),
		});
	} else {
		void act("encoder-start", "encoder.start", { ...common, host: data.get("host"), port: data.get("port") });
	}
};
byId<HTMLInputElement>("autostart").onchange = async (e) => {
	const box = e.currentTarget as HTMLInputElement;
	box.disabled = true;
	const result = await act<{ autostart: boolean } | null>(null, "autostart.set", { enabled: box.checked });
	box.disabled = false;
	box.checked = result ? result.autostart : !box.checked;
};
byId<HTMLSelectElement>("pipeline").onchange = () => updatePipelineFields();
for (const id of ["audio-source", "audio-codec", "bitrate-overlay"]) {
	byId(id).addEventListener("change", () => touched.add(id));
}
byId<HTMLButtonElement>("encoder-stop").onclick = () => void act("encoder-stop", role === "combined" ? "stream.stop" : "encoder.stop");
byId<HTMLButtonElement>("encoder-bitrate").onclick = () => {
	const input = byId<HTMLFormElement>("encoder-form").elements.namedItem("maxBitrate") as HTMLInputElement;
	void act("encoder-bitrate", "encoder.bitrate", { maxBitrate: optionalNumber(input.value) });
};

// Refresh relative times ("12s ago") without waiting for a push
setInterval(() => {
	if (!lastStatus) return;
	if (role !== "relay") renderEncoder(lastStatus);
	if (role !== "encoder") renderSrtla(lastStatus);
	if (stats) renderStatsAge();
}, 5_000);

connect();
