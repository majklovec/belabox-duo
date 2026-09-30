import m from "mithril";
import { byId } from "./dom";
import type { AudioSource, Pipeline, Role } from "../types";

type Params = Record<string, unknown>;
interface SetupInfo {
	required: boolean;
	hostname: string;
	color: string;
	pipelines: Pipeline[];
	audioSources: AudioSource[];
}

let ws: WebSocket | null = null;
let nextId = 1;
let current = 0;
let steps: HTMLElement[] = [];
const pending = new Map<number, { resolve: (value: unknown) => void; reject: (error: Error) => void }>();

function call<T>(method: string, params?: Params): Promise<T> {
	return new Promise((resolve, reject) => {
		if (!ws || ws.readyState !== WebSocket.OPEN) return reject(new Error("not connected"));
		const id = nextId++;
		pending.set(id, { resolve: (value) => resolve(value as T), reject });
		ws.send(JSON.stringify({ id, method, params }));
	});
}

function selectedRole(): Role | undefined {
	return new FormData(byId<HTMLFormElement>("setup-form")).get("role") as Role | undefined;
}

/**
 * Only required fields in *visible* steps may block submission — a hidden
 * required control rejects the form save with no visible feedback.
 */
function applyRequired(role: Role | undefined): void {
	const form = byId<HTMLFormElement>("setup-form");
	const visible = (el: HTMLElement) => !el.closest<HTMLElement>(".wizard-step")?.hidden;
	const fields: Record<string, boolean> = {
		pipeline: role !== "relay",
		audioSource: role !== "relay",
		encoderHost: role === "encoder",
		encoderPort: role === "encoder",
		listenPort: true,
		srtlaRemoteHost: role !== "encoder",
		srtlaRemotePort: role !== "encoder",
	};
	for (const [name, force] of Object.entries(fields)) {
		const input = form.elements.namedItem(name) as HTMLElement | null;
		if (input) (input as HTMLInputElement).required = visible(input) && force;
	}
}

function rebuildSteps(): void {
	const role = selectedRole();
	steps = [...document.querySelectorAll<HTMLElement>(".wizard-step")].filter((step) => {
		if (step.dataset.step === "encoder") return role !== "relay";
		if (step.dataset.step === "relay") return role !== "encoder";
		return true;
	});
	const fieldsets = new Map(steps.map((step) => [step.dataset.step, step] as const));
	for (const item of document.querySelectorAll<HTMLElement>(".wiz-item")) {
		item.hidden = !fieldsets.has(item.dataset.step);
		item.className = "wiz-item";
	}
	const combined = role === "combined";
	for (const field of document.querySelectorAll<HTMLElement>(".encoder-target")) field.hidden = combined;
	current = Math.min(current, steps.length - 1);
	applyRequired(role);
	renderStep();
}

function renderStep(): void {
	for (const step of document.querySelectorAll<HTMLElement>(".wizard-step")) step.hidden = step !== steps[current];
	const items = [...document.querySelectorAll<HTMLElement>(".wiz-item")].filter((item) => !item.hidden);
	items.forEach((item, i) => {
		item.className = `wiz-item ${i < current ? "done" : i === current ? "current" : "upcoming"}`;
		item.querySelector(".wiz-dot")!.textContent = i < current ? "✓" : String(i + 1);
	});
	byId<HTMLButtonElement>("previous").hidden = current === 0;
	const last = current === steps.length - 1;
	byId<HTMLButtonElement>("next").hidden = last;
	byId<HTMLButtonElement>("complete").hidden = !last;
}

function populate(info: SetupInfo): void {
	if (!info.required) {
		location.replace("../");
		return;
	}
	const form = byId<HTMLFormElement>("setup-form");
	(form.elements.namedItem("hostname") as HTMLInputElement).value = info.hostname;
	(form.elements.namedItem("color") as HTMLInputElement).value = info.color;
	m.render(form.elements.namedItem("pipeline") as HTMLSelectElement, info.pipelines.map((item) => m("option", { value: item.id }, item.id)));
	m.render(form.elements.namedItem("audioSource") as HTMLSelectElement, info.audioSources.map((item) => m("option", { value: item.id }, item.name)));
	rebuildSteps();
}

function connect(): void {
	const url = new URL("../ws", location.href);
	url.protocol = location.protocol === "https:" ? "wss:" : "ws:";
	ws = new WebSocket(url);
	ws.onopen = async () => {
		byId("conn").textContent = "connected";
		byId("conn").className = "badge on";
		try { populate(await call<SetupInfo>("setup.get")); }
		catch (error: unknown) { byId("result").textContent = error instanceof Error ? error.message : String(error); }
	};
	ws.onmessage = (event) => {
		const message = JSON.parse(String(event.data));
		if (message.type !== "response") return;
		const request = pending.get(message.id);
		if (!request) return;
		pending.delete(message.id);
		message.ok ? request.resolve(message.result) : request.reject(new Error(message.error));
	};
	ws.onclose = () => {
		byId("conn").textContent = "disconnected";
		byId("conn").className = "badge off";
		for (const request of pending.values()) request.reject(new Error("connection closed"));
		pending.clear();
		setTimeout(connect, 2_000);
	};
}

byId<HTMLFormElement>("setup-form").addEventListener("change", (event) => {
	if ((event.target as HTMLInputElement).name === "role") rebuildSteps();
	if ((event.target as HTMLInputElement).name === "color") {
		document.documentElement.style.setProperty("--header-color", (event.target as HTMLInputElement).value);
	}
});
byId<HTMLButtonElement>("next").onclick = () => {
	const inputs = [...steps[current].querySelectorAll<HTMLInputElement | HTMLSelectElement>("input, select")];
	if (!inputs.every((input) => input.reportValidity())) return;
	current++;
	renderStep();
};
byId<HTMLButtonElement>("previous").onclick = () => {
	current--;
	renderStep();
};
byId<HTMLFormElement>("setup-form").onsubmit = async (event) => {
	event.preventDefault();
	const form = event.currentTarget as HTMLFormElement;
	const data = new FormData(form);
	const role = data.get("role") as Role;
	const button = byId<HTMLButtonElement>("complete");
	button.disabled = true;
	try {
		await call("setup.complete", {
			role,
			hostname: data.get("hostname"),
			color: data.get("color"),
			remoteUrl: data.get("remoteUrl"),
			remoteToken: data.get("remoteToken"),
			...(role !== "relay" ? {
				pipeline: data.get("pipeline"),
				maxBitrate: Number(data.get("maxBitrate")),
				audioSource: data.get("audioSource"),
				audioCodec: data.get("audioCodec"),
				delay: Number(data.get("delay")),
				encoderHost: data.get("encoderHost"),
				encoderPort: Number(data.get("encoderPort")),
				latency: Number(data.get("latency")),
				streamid: data.get("streamid"),
				bitrateOverlay: data.get("bitrateOverlay") === "on",
			} : {}),
			...(role !== "encoder" ? {
				listenPort: Number(data.get("listenPort")),
				srtlaRemoteHost: data.get("srtlaRemoteHost"),
				srtlaRemotePort: Number(data.get("srtlaRemotePort")),
				srtlaMode: data.get("srtlaMode"),
				srtlaQuality: data.get("srtlaQuality") === "on",
			} : {}),
			autostart: data.get("autostart") === "on",
		});
		form.hidden = true;
		byId("result").textContent = "Configuration saved. Restart the service to apply the selected role, hostname and control server.";
	} catch (error: unknown) {
		byId("result").textContent = error instanceof Error ? error.message : String(error);
		button.disabled = false;
	}
};

connect();
