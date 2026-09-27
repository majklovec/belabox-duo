import { badge, byId, type Child, h, since } from "./dom";
import { roleTag } from "./icons";
import type { ModemInfo } from "../src/modems";
import type { DeviceInfo, Pipeline, Role, Status } from "./types";

type Params = Record<string, unknown>;

const CALL_TIMEOUT_MS = 30_000;
const RECONNECT_MS = 2_000;

function definitionList(target: HTMLElement, rows: [string, Child][]): void {
	target.replaceChildren(...rows.flatMap(([k, v]) => [h("dt", {}, k), h("dd", {}, v ?? "—")]));
}

function log(message: string, error = false): void {
	const list = byId<HTMLOListElement>("log");
	list.prepend(
		h("li", { className: error ? "error" : "" }, h("time", {}, new Date().toLocaleTimeString()), message),
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
	document.title = `${info.id} — SRTLA Relay`;
	if (wasOnline !== undefined && wasOnline !== info.online) {
		log(`Device ${info.online ? "online" : "offline"}`, !info.online);
		if (info.online) pipelinesLoaded = false;
	}
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
		for (const p of pending.values()) p.reject(new Error("connection closed"));
		pending.clear();
		setTimeout(connect, RECONNECT_MS);
	};

	ws.onmessage = (e) => {
		const msg = JSON.parse(String(e.data));
		if (msg.type === "event" && msg.event === "status") {
			render(msg.data as Status);
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

/** Run a method with the button disabled while in flight; logs the outcome. */
async function act<T = unknown>(
	button: HTMLButtonElement | null,
	method: string,
	params?: Params,
): Promise<T | undefined> {
	if (button) button.disabled = true;
	try {
		const result = await call<T>(method, params);
		log(`${method} ✓`);
		return result;
	} catch (err) {
		log(`${method}: ${err instanceof Error ? err.message : String(err)}`, true);
		return undefined;
	} finally {
		if (button) button.disabled = false;
	}
}

// ----------------------------------------------------------------------
// Rendering
// ----------------------------------------------------------------------
function renderSrtla(status: Status): void {
	const s = status.state.srtla;
	definitionList(byId("srtla-info"), [
		["State", s.running ? badge("running", "on") : badge("stopped", "off")],
		["PID", s.pid],
		// On combined devices the listen port is an internal belacoder → srtla_send detail
		["Target", s.remoteHost ? `${s.remoteHost}:${s.remotePort}${role === "combined" ? "" : ` (listen ${s.listenPort})`}` : null],
		["Started", s.running ? since(s.startedAt) : null],
		["Reloads", `${s.reloadCount ?? 0} (last ${since(s.lastReloadAt)}, mode ${status.monitor.reloadMode})`],
		["Monitor", status.monitor.running ? badge("watching", "on") : badge("off", "warn")],
		["Uplinks file", status.uplinksFile],
	]);

	// Prefill the form from the last known target without clobbering user input
	const form = byId<HTMLFormElement>("srtla-form");
	for (const key of ["listenPort", "remoteHost", "remotePort"] as const) {
		const input = form.elements.namedItem(key) as HTMLInputElement;
		const value = s[key] ?? status.state.srtlaTarget?.[key];
		if (!input.value && document.activeElement !== input && value) input.value = value;
	}
}

function renderInterfaces(status: Status): void {
	const { selection } = status.state;
	const selected = new Set(status.selected.map((i) => i.iface));
	const explicit = !!(selection.modems?.length || selection.ips?.length);

	byId("selection-mode").textContent = explicit
		? `Bonding ${selected.size} selected interface(s).`
		: "No explicit selection — bonding all detected interfaces (or modems.json).";

	const rows = status.interfaces.map((i) => {
		const box = h("input", { type: "checkbox", checked: selected.has(i.iface), title: "Include in bond" });
		box.onchange = async () => {
			box.disabled = true;
			await act(null, "modems.toggle", { iface: i.iface });
			box.disabled = false;
		};
		return h(
			"tr",
			{ className: selected.has(i.iface) ? "selected" : "" },
			h("td", {}, box),
			h("td", {}, i.iface),
			h("td", {}, i.cidr),
			h("td", {}, i.modemIndex !== undefined ? `#${i.modemIndex}` : "—"),
			h("td", {}, signal(i.signalQuality)),
			h("td", {}, i.operatorName ?? "—"),
			h("td", {}, i.accessTech ?? "—"),
		);
	});
	byId("iface-rows").replaceChildren(
		...(rows.length ? rows : [h("tr", {}, h("td", { colSpan: 7, className: "muted" }, "No interfaces detected"))]),
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

	// Keep the AT console modem picker in sync, preserving the current choice
	const select = byId<HTMLSelectElement>("at-modem");
	const current = select.value;
	select.replaceChildren(
		...modems.map((m) => h("option", { value: String(m.index) }, `#${m.index} ${m.model ?? ""}`)),
	);
	if (modems.some((m) => String(m.index) === current)) select.value = current;
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

	byId("encoder-title").textContent = combined ? "Stream (belacoder → srtla_send)" : "Encoder (belacoder)";

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
	byId<HTMLButtonElement>("encoder-bitrate").disabled = !e.running;

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
	for (const id of ["srtla", "interfaces", "modems", "at"]) byId(id).hidden = !hasRelay;
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
	const form = e.currentTarget as HTMLFormElement;
	const params = Object.fromEntries(new FormData(form));
	void act(byId<HTMLButtonElement>("srtla-start"), "srtla.start", params);
};
byId<HTMLButtonElement>("srtla-stop").onclick = (e) =>
	void act(e.currentTarget as HTMLButtonElement, "srtla.stop");
byId<HTMLButtonElement>("srtla-reload").onclick = (e) =>
	void act(e.currentTarget as HTMLButtonElement, "srtla.reload");
byId<HTMLButtonElement>("reconfigure").onclick = (e) =>
	void act(e.currentTarget as HTMLButtonElement, "reconfigure");

const optionalNumber = (v: FormDataEntryValue | null) => (v === null || v === "" ? undefined : Number(v));

byId<HTMLFormElement>("encoder-form").onsubmit = (e) => {
	e.preventDefault();
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
	const button = byId<HTMLButtonElement>("encoder-start");
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

byId<HTMLFormElement>("at-form").onsubmit = async (e) => {
	e.preventDefault();
	const form = e.currentTarget as HTMLFormElement;
	const data = new FormData(form);
	const button = form.querySelector("button");
	const result = await act<{ output: string }>(button, "modems.at", {
		index: Number(data.get("index")),
		command: String(data.get("command")),
	});
	if (result) byId("at-output").textContent = result.output || "(no output)";
};

// Refresh relative times ("12s ago") without waiting for a push
setInterval(() => {
	if (!lastStatus) return;
	if (role !== "relay") renderEncoder(lastStatus);
	if (role !== "encoder") renderSrtla(lastStatus);
}, 5_000);

connect();
