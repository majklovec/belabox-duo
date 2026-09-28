import { badge, byId, type Child, formatBitrate, h, since } from "./dom";
import { roleTag } from "./icons";
import type { ModemInfo } from "../../src/modems";
import type { DeviceInfo, Pipeline, Role, SrtlaLinkStats, SrtlaStats, SrtlaStatsEvent, Status } from "../types";

type Params = Record<string, unknown>;

const CALL_TIMEOUT_MS = 30_000;
const RECONNECT_MS = 2_000;
const STATS_STALE_MS = 5_000;

function definitionList(target: HTMLElement, rows: [string, Child][]): void {
	target.replaceChildren(...rows.flatMap(([k, v]) => [h("dt", {}, k), h("dd", {}, v ?? "—")]));
}

function log(message: string, error = false): void {
	const list = byId<HTMLOListElement>("log");
	list.prepend(
		h("p", { className: error ? "error" : "" }, h("time", {}, new Date().toLocaleTimeString()), message),
	);
	while (list.children.length > 50) list.lastElementChild?.remove();
}

// ----------------------------------------------------------------------
// WebSocket client
// ----------------------------------------------------------------------
let ws: WebSocket | null = null;
let nextId = 1;
const pending = new Map<number, { resolve: (v: unknown) => void; reject: (e: Error) => void }>();

let socketOpen = false;
let device: DeviceInfo | null = null;   // null = talking to the relay directly

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
	if (wasOnline !== undefined && wasOnline !== info.online) {
		log(`Device ${info.online ? "online" : "offline"}`, !info.online);
		if (info.online) pipelinesLoaded = false;
	}
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
		log("Connected");
	};

	ws.onclose = () => {
		setConnected(false);
		setStats(null);
		for (const p of pending.values()) p.reject(new Error("connection closed"));
		pending.clear();
		setTimeout(connect, RECONNECT_MS);
	};

	ws.onmessage = (e) => {
		const msg = JSON.parse(String(e.data));
		if (msg.type === "event" && msg.event === "status") {
			render(msg.data as Status);
		} else if (msg.type === "event" && msg.event === "srtla.stats") {
			setStats((msg.data as SrtlaStatsEvent).stats);
		} else if (msg.type === "event" && msg.event === "device") {
			renderDevice(msg.data as DeviceInfo);
		} else if (msg.type === "response") {
			const p = pending.get(msg.id);
			if (!p) return;
			pending.delete(msg.id);
			if (msg.ok) p.resolve(msg.result);
			else p.reject(new Error(msg.error));
		}
	};
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
const inFlight = new Set<HTMLButtonElement>();
const awaitingStatus = new Set<HTMLButtonElement>();

function updateStateButtons(): void {
	for (const [id, allowed] of Object.entries(STATE_BUTTONS)) {
		const b = byId<HTMLButtonElement>(id);
		b.disabled = inFlight.has(b) || awaitingStatus.has(b) || !lastStatus || !allowed(lastStatus);
	}
}

/** Run a method with the button disabled while in flight; logs the outcome. */
async function act<T = unknown>(
	button: HTMLButtonElement | null,
	method: string,
	params?: Params,
): Promise<T | undefined> {
	if (button) {
		inFlight.add(button);
		button.disabled = true;
	}
	let ok = false;
	try {
		const result = await call<T>(method, params);
		ok = true;
		log(`${method} ✓`);
		return result;
	} catch (err) {
		log(`${method}: ${err instanceof Error ? err.message : String(err)}`, true);
		return undefined;
	} finally {
		if (button) {
			inFlight.delete(button);
			if (!(button.id in STATE_BUTTONS)) button.disabled = false;
			else {
				if (ok) {
					awaitingStatus.add(button);
					setTimeout(() => {
						awaitingStatus.delete(button);
						updateStateButtons();
					}, AWAIT_STATUS_MS);
				}
				updateStateButtons();
			}
		}
	}
}

// ----------------------------------------------------------------------
// Rendering
// ----------------------------------------------------------------------
function renderSrtla(status: Status): void {
	const s = status.state.srtla;
	definitionList(byId("srtla-info"), [
		["State", s.running ? badge("running", "on") : badge("stopped", "off")],
		// On combined devices the listen port is an internal belacoder → srtla_send detail
		["Target", s.remoteHost ? `${s.remoteHost}:${s.remotePort}${role === "combined" ? "" : ` (listen ${s.listenPort})`}` : null],
		["Started", s.running ? since(s.startedAt) : null],
		["Reloads", `${s.reloadCount ?? 0} (last ${since(s.lastReloadAt)}, mode ${status.monitor.reloadMode})`],
		["Monitor", status.monitor.running ? badge("watching", "on") : badge("off", "warn")],
		["Control", s.running ? controlBadge(status) : null],
		["Uplinks file", status.uplinksFile],
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

function controlBadge(status: Status): Child {
	const c = status.srtlaControl;
	if (c?.connected) return badge("connected", "on");
	if (c?.supported) return badge("connecting", "warn");
	return h("span", { className: "muted", title: "srtla_send without --control-socket: no link stats" }, "unavailable");
}

/** Scheduler controls: the saved settings, else what the running srtla_send reports, else its defaults. */
function renderSrtlaOptions(status: Status): void {
	const opts = status.state.srtlaOptions ?? {};
	const live = status.state.srtla.running ? stats : null;
	const mode = opts.mode ?? live?.mode ?? "enhanced";
	const modeSelect = byId<HTMLSelectElement>("srtla-mode");
	const quality = byId<HTMLInputElement>("srtla-quality");
	if (!modeSelect.disabled && document.activeElement !== modeSelect) modeSelect.value = mode;
	if (!quality.dataset.busy) {
		quality.checked = opts.quality ?? live?.quality_enabled ?? true;
		quality.disabled = mode === "classic";
	}
}

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
	if (l.weak) return h("span", { title: l.weak_reason ?? "" }, badge("weak", "warn"));
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
	age.replaceChildren(stale ? badge(`stale, ${since(statsAt)}`, "warn") : "live");
}

/** Link columns for an interface; srtla_send links are matched to interfaces by source IP. */
function linkCells(l: SrtlaLinkStats | undefined, total: number): HTMLTableCellElement[] {
	const cell = (child: Child, props: Partial<HTMLTableCellElement> = {}) =>
		h("td", { ...props, className: `link-col ${props.className ?? ""}`.trim() }, child);
	if (!l) return Array.from({ length: 7 }, () => cell("—", { className: "muted" }));
	const share = total ? l.bitrate_bytes_per_sec / total : 0;
	return [
		cell(linkState(l), { title: l.label ?? "" }),
		cell(
			h(
				"span",
				{},
				h("meter", { className: "share", min: 0, max: 1, value: share, title: `${Math.round(share * 100)}% of total` }),
				formatBitrate(l.bitrate_bytes_per_sec),
			),
			{ className: "num" },
		),
		cell(l.connected ? `${Math.round(l.rtt_ms)} ms` : "—", {
			className: "num",
			title: `min ${Math.round(l.rtt_min_ms)} ms`,
		}),
		cell(`${l.in_flight} / ${l.window}`, { className: "num" }),
		cell(l.nak_count, { className: "num" }),
		cell(`${((l.cc_loss_permille ?? 0) / 10).toFixed(1)}%`, { className: "num" }),
		cell(l.quality_multiplier !== undefined ? `×${l.quality_multiplier.toFixed(2)}` : "—", {
			className: "num",
			title: l.base_score !== undefined ? `score ${l.base_score}` : "",
		}),
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
		const box = h("input", {
			type: "checkbox",
			checked: selected.has(i.iface),
			disabled: togglingIfaces.has(i.iface),
			title: "Include in bond",
		});
		box.onchange = async () => {
			togglingIfaces.add(i.iface);
			box.disabled = true;
			await act(null, "modems.toggle", { iface: i.iface });
			togglingIfaces.delete(i.iface);
			box.disabled = false;
		};
		const sub = [i.cidr, i.modemIndex !== undefined ? `modem #${i.modemIndex}` : null].filter(Boolean).join(" · ");
		const network = [i.operatorName, i.accessTech].filter(Boolean).join(" · ");
		return h(
			"tr",
			{ className: selected.has(i.iface) ? "selected" : "" },
			h("td", {}, box),
			h(
				"td",
				{},
				i.iface,
				i.speed ? h("small", { className: "muted" }, ` · ${formatSpeed(i.speed)}`) : null,
				sub ? h("span", { className: "iface-sub muted" }, sub) : null,
			),
			h("td", {}, signal(i.signalQuality)),
			h("td", {}, network || "—"),
			...linkCells(links.get(i.ip), total),
		);
	});
	byId("iface-rows").replaceChildren(
		...(rows.length ? rows : [h("tr", {}, h("td", { colSpan: 11, className: "muted" }, "No interfaces detected"))]),
	);
}

function signal(quality?: number): Child {
	if (quality === undefined) return "—";
	return h(
		"span",
		{},
		h("meter", { min: 0, max: 100, low: 30, high: 60, optimum: 100, value: quality }),
		` ${quality}%`,
	);
}

function modemButton(label: string, method: string, index: number, className = "secondary") {
	const btn = h("button", { type: "button", className }, label);
	btn.onclick = () => {
		if (method === "modems.reset" && !confirm(`Reset modem #${index}?`)) return;
		void act(btn, method, { index });
	};
	return btn;
}

function renderModems(modems: ModemInfo[]): void {
	const cards = modems.map((m) => {
		const connected = m.state === "connected";
		return h(
			"article",
			{ className: "modem" },
			h(
				"h3",
				{},
				`#${m.index} ${[m.manufacturer, m.model].filter(Boolean).join(" ") || "Modem"}`,
				badge(m.state, connected ? "on" : m.state === "disabled" || m.state === "failed" ? "off" : "warn"),
			),
			(() => {
				const dl = h("dl");
				definitionList(dl, [
					["Signal", signal(m.signalQuality)],
					["Operator", m.operatorName],
					["Tech", m.accessTech],
					["Registration", m.registrationState],
					["Power", m.powerState],
					["IMEI", m.imei],
				]);
				return dl;
			})(),
			h(
				"div",
				{ className: "actions" },
				modemButton("Enable", "modems.enable", m.index),
				modemButton("Disable", "modems.disable", m.index),
				connected
					? modemButton("Disconnect", "modems.disconnect", m.index)
					: modemButton("Connect", "modems.connect", m.index),
				modemButton("Reset", "modems.reset", m.index, "danger"),
			),
		);
	});
	byId("modem-list").replaceChildren(
		...(cards.length ? cards : [h("p", { className: "muted" }, "No modems found (ModemManager).")]),
	);

}

// ----------------------------------------------------------------------
// Encoder (encoder and combined roles)
// ----------------------------------------------------------------------
let pipelinesLoaded = false;
let role: Role = "relay";
const pipelines = new Map<string, Pipeline>();
let lastLoggedEncoderError: string | undefined;

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
	const result = await act<{ dir: string; pipelines: Pipeline[] }>(null, "pipelines.list");
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
	const nodes: Node[] = [];
	for (const [group, list] of groups) {
		const options = list.map((p) => h("option", { value: p.id }, p.name));
		if (group) nodes.push(h("optgroup", { label: group }, ...options));
		else nodes.push(...options);
	}
	if (!nodes.length) nodes.push(h("option", { value: "", disabled: true }, `No pipelines in ${result.dir}`));
	select.replaceChildren(...nodes);
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
	if (e.lastError !== lastLoggedEncoderError) {
		lastLoggedEncoderError = e.lastError;
		if (e.lastError) log(`Encoder: ${e.lastError}`, true);
	}

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
				? `${status.audioSources.find((a) => a.id === cfg.audioSource)?.name ?? cfg.audioSource ?? "Pipeline default"}, ${(cfg.audioCodec ?? "aac").toUpperCase()}`
				: null,
		],
		["Started", e.running ? since(e.startedAt) : null],
		["Restarts", e.running ? (e.restarts ?? 0) : null],
		["Last error", e.lastError],
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
	asrc.replaceChildren(...status.audioSources.map((a) => h("option", { value: a.id }, a.name)));
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
		roleBadge.replaceChildren(roleTag(role));
	}
	byId("encoder").hidden = !hasEncoder;
	for (const id of ["srtla", "interfaces", "modems"]) byId(id).hidden = !hasRelay;
	// Combined: the receiver is entered in the srtla_send card, but the stream card's single
	// Start/Stop drives srtla_send, and its local listen port is internal
	const combined = role === "combined";
	byId("srtla-listen-field").hidden = combined;
	byId("srtla-actions").hidden = combined;
	byId("srtla-host-label").textContent = combined ? "SRTLA receiver host" : "Remote host";
	byId("srtla-port-label").textContent = combined ? "SRTLA receiver port" : "Remote port";
	byId("encoder-host-field").hidden = combined;
	byId("encoder-port-field").hidden = combined;
	// Hidden required inputs would block form submission
	setRequired("srtla-form", "listenPort", !combined);
	setRequired("encoder-form", "host", !combined);
	setRequired("encoder-form", "port", !combined);
	if (hasEncoder && !pipelinesLoaded) void loadPipelines();
}

let lastStatus: Status | null = null;

function render(status: Status): void {
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
// Static controls
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
	const form = e.currentTarget as HTMLFormElement;
	const params = Object.fromEntries(new FormData(form));
	void act(button, "srtla.start", params);
};
byId<HTMLButtonElement>("srtla-stop").onclick = (e) =>
	void act(e.currentTarget as HTMLButtonElement, "srtla.stop");
byId<HTMLButtonElement>("srtla-reload").onclick = (e) =>
	void act(e.currentTarget as HTMLButtonElement, "srtla.reload");
async function setSrtlaOption(el: HTMLInputElement | HTMLSelectElement, params: Params): Promise<void> {
	el.disabled = true;
	el.dataset.busy = "1";
	const result = await act<{ options: Status["state"]["srtlaOptions"]; applied: boolean }>(null, "srtla.options", params);
	el.disabled = false;
	delete el.dataset.busy;
	// The status push is debounced; do not flash the old value until it arrives
	if (result && lastStatus) lastStatus.state.srtlaOptions = result.options;
	if (result && !result.applied && lastStatus?.state.srtla.running) {
		log("srtla_send has no control socket; the setting applies on the next start");
	}
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
byId<HTMLButtonElement>("reconfigure").onclick = (e) =>
	void act(e.currentTarget as HTMLButtonElement, "reconfigure");

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
		void act(button, "stream.start", {
			...common,
			remoteHost: r.get("remoteHost"),
			remotePort: r.get("remotePort"),
		});
	} else {
		void act(button, "encoder.start", { ...common, host: data.get("host"), port: data.get("port") });
	}
};
byId<HTMLInputElement>("autostart").onchange = async (e) => {
	const box = e.currentTarget as HTMLInputElement;
	box.disabled = true;
	const result = await act<{ autostart: boolean }>(null, "autostart.set", { enabled: box.checked });
	box.disabled = false;
	box.checked = result ? result.autostart : !box.checked;
};
byId<HTMLSelectElement>("pipeline").onchange = updatePipelineFields;
for (const id of ["audio-source", "audio-codec", "bitrate-overlay"]) {
	byId(id).addEventListener("change", () => touched.add(id));
}
byId<HTMLButtonElement>("encoder-stop").onclick = (e) =>
	void act(e.currentTarget as HTMLButtonElement, role === "combined" ? "stream.stop" : "encoder.stop");
byId<HTMLButtonElement>("encoder-bitrate").onclick = (e) => {
	const input = byId<HTMLFormElement>("encoder-form").elements.namedItem("maxBitrate") as HTMLInputElement;
	void act(e.currentTarget as HTMLButtonElement, "encoder.bitrate", { maxBitrate: optionalNumber(input.value) });
};

// Refresh relative times ("12s ago") without waiting for a push
setInterval(() => {
	if (!lastStatus) return;
	if (role !== "relay") renderEncoder(lastStatus);
	if (role !== "encoder") renderSrtla(lastStatus);
	if (stats) renderStatsAge();
}, 5_000);

connect();
