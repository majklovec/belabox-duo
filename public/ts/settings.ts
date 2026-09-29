import { byId } from "./dom";

type Params = Record<string, unknown>;
interface Settings {
	hostname: string;
	role: string;
	remoteUrl: string;
	hasRemoteToken: boolean;
	color: string;
}

let ws: WebSocket | null = null;
let nextId = 1;
const pending = new Map<number, { resolve: (value: unknown) => void; reject: (error: Error) => void }>();

function call<T>(method: string, params?: Params): Promise<T> {
	return new Promise((resolve, reject) => {
		if (!ws || ws.readyState !== WebSocket.OPEN) {
			reject(new Error("not connected"));
			return;
		}
		const id = nextId++;
		pending.set(id, { resolve: (value) => resolve(value as T), reject });
		ws.send(JSON.stringify({ id, method, params }));
	});
}

function applyColor(color: string): void {
	document.documentElement.style.setProperty("--header-color", color);
}

function fill(settings: Settings): void {
	const form = byId<HTMLFormElement>("settings-form");
	for (const key of ["hostname", "role", "remoteUrl", "color"] as const) {
		const input = form.elements.namedItem(key) as HTMLInputElement | HTMLSelectElement;
		input.value = settings[key];
	}
	const token = form.elements.namedItem("remoteToken") as HTMLInputElement;
	token.placeholder = settings.hasRemoteToken ? "configured (leave blank to keep)" : "not configured";
	applyColor(settings.color);
}

function connect(): void {
	const url = new URL("../ws", location.href);
	url.protocol = location.protocol === "https:" ? "wss:" : "ws:";
	ws = new WebSocket(url);
	ws.onopen = async () => {
		const conn = byId("conn");
		conn.textContent = "connected";
		conn.className = "badge on";
		try {
			const result = await call<{ settings: Settings }>("settings.get");
			fill(result.settings);
		} catch (error: unknown) {
			byId("result").textContent = error instanceof Error ? error.message : String(error);
		}
	};
	ws.onmessage = (event) => {
		const message = JSON.parse(String(event.data));
		if (message.type !== "response") return;
		const request = pending.get(message.id);
		if (!request) return;
		pending.delete(message.id);
		if (message.ok) request.resolve(message.result);
		else request.reject(new Error(message.error));
	};
	ws.onclose = () => {
		const conn = byId("conn");
		conn.textContent = "disconnected";
		conn.className = "badge off";
		for (const request of pending.values()) request.reject(new Error("connection closed"));
		pending.clear();
		setTimeout(connect, 2_000);
	};
}

byId<HTMLFormElement>("settings-form").onsubmit = async (event) => {
	event.preventDefault();
	const form = event.currentTarget as HTMLFormElement;
	const button = byId<HTMLButtonElement>("save");
	const data = new FormData(form);
	button.disabled = true;
	byId("result").textContent = "";
	try {
		const result = await call<{ settings: Settings }>("settings.update", {
			hostname: data.get("hostname"),
			role: data.get("role"),
			remoteUrl: data.get("remoteUrl"),
			color: data.get("color"),
			...(data.get("remoteToken") ? { remoteToken: data.get("remoteToken") } : {}),
		});
		fill(result.settings);
		(form.elements.namedItem("remoteToken") as HTMLInputElement).value = "";
		byId("result").textContent = "Settings saved.";
	} catch (error: unknown) {
		byId("result").textContent = error instanceof Error ? error.message : String(error);
	} finally {
		button.disabled = false;
	}
};

connect();
