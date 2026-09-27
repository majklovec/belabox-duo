import { badge, byId, type Child, h, since } from "./dom";
import type { ModemInfo } from "../src/modems";
import type { DeviceInfo, Status } from "./types";

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
		["Target", s.remoteHost ? `${s.remoteHost}:${s.remotePort} (listen ${s.listenPort})` : null],
		["Started", s.running ? since(s.startedAt) : null],
		["Reloads", `${s.reloadCount ?? 0} (last ${since(s.lastReloadAt)}, mode ${status.monitor.reloadMode})`],
		["Monitor", status.monitor.running ? badge("watching", "on") : badge("off", "warn")],
		["Uplinks file", status.uplinksFile],
	]);

	// Prefill the form from the last known target without clobbering user input
	const form = byId<HTMLFormElement>("srtla-form");
	for (const key of ["listenPort", "remoteHost", "remotePort"] as const) {
		const input = form.elements.namedItem(key) as HTMLInputElement;
		if (!input.value && document.activeElement !== input && s[key]) input.value = s[key] ?? "";
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

let lastStatus: Status | null = null;

function render(status: Status): void {
	lastStatus = status;
	renderSrtla(status);
	renderInterfaces(status);
	renderModems(status.modems);
}

// ----------------------------------------------------------------------
// Static controls
// ----------------------------------------------------------------------
byId<HTMLFormElement>("srtla-form").onsubmit = (e) => {
	e.preventDefault();
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
setInterval(() => lastStatus && renderSrtla(lastStatus), 5_000);

connect();
