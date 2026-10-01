/* First-run setup wizard — a fully Mithril view: stepper, one fieldset per step,
 * Back / Next / Save controls, all driven by a single state object. */
import m from "mithril";
import { Page, badge } from "./components/ui";
import { byId } from "./dom";
import type { Params } from "./services/rpc";
import { RpcClient, socketUrl } from "./services/rpc";
import { LANGUAGES, languageLabel, lang, setLanguage, t } from "./i18n";
import type { AudioSource, Pipeline, Role } from "../types";

interface SetupInfo {
	required: boolean;
	hostname: string;
	color: string;
	language: string;
	pipelines: Pipeline[];
	audioSources: AudioSource[];
}

type StepKey = "language" | "role" | "identity" | "control" | "encoder" | "relay" | "finish";

const STEPS: { key: StepKey; title: string | (() => string); sub: string | (() => string) }[] = [
	// The language step is a live function so switching it re-renders the stepper in the new language.
	{ key: "language", title: () => t("ui.language_label"), sub: () => t("setup.step.language_sub") },
	{ key: "role", title: () => t("set.role"), sub: () => t("setup.step.role_sub") },
	{ key: "identity", title: () => t("setup.step.identity"), sub: () => t("setup.step.identity_sub") },
	{ key: "control", title: () => t("setup.step.control"), sub: () => t("setup.step.control_sub") },
	{ key: "encoder", title: () => t("setup.step.encoder"), sub: () => t("setup.step.encoder_sub") },
	{ key: "relay", title: () => t("setup.step.relay"), sub: () => t("setup.step.relay_sub") },
	{ key: "finish", title: () => t("setup.step.review"), sub: () => t("setup.save") },
];

// A step applies only for roles where it makes sense
const stepVisible = (key: StepKey, role: Role | undefined): boolean => {
	if (key === "encoder") return role !== "relay";
	if (key === "relay") return role !== "encoder";
	return true;
};

const HOSTNAME_RE = /^[A-Za-z0-9][A-Za-z0-9.-]{0,62}$/;
const inRange = (value: string, min: number, max: number) => {
	const n = Number(value);
	return value !== "" && n >= min && n <= max;
};

const state = {
	connected: false,
	loaded: false,
	current: 0,
	language: "en",
	role: undefined as Role | undefined,
	hostname: "",
	color: "#0f1115",
	remoteUrl: "",
	remoteToken: "",
	pipeline: "",
	maxBitrate: "5000",
	audioSource: "",
	audioCodec: "aac",
	delay: "0",
	encoderHost: "",
	encoderPort: "6000",
	latency: "2000",
	streamid: "",
	bitrateOverlay: false,
	listenPort: "6000",
	srtlaRemoteHost: "",
	srtlaRemotePort: "5000",
	srtlaMode: "enhanced",
	srtlaQuality: true,
	autostart: false,
	pipelines: [] as Pipeline[],
	audioSources: [] as AudioSource[],
	message: "",
	saving: false,
	saved: false,
};

const num = (s: string): number => (s === "" ? 0 : Number(s));

const visibleSteps = () => STEPS.filter((s) => stepVisible(s.key, state.role));

/** A step passes when every mandatory field in it is satisfied (same rules as the
 * native `required`/min/max constraints the old markup carried). */
function stepValid(key: StepKey): boolean {
	switch (key) {
		case "role":
			return !!state.role;
		case "identity":
			return HOSTNAME_RE.test(state.hostname);
		case "encoder":
			if (!state.pipeline || !state.audioSource) return false;
			if (!inRange(state.maxBitrate, 300, 30000) || !inRange(state.latency, 100, 10000)) return false;
			if (state.role === "encoder") return !!state.encoderHost && inRange(state.encoderPort, 1, 65535);
			return true;
		case "relay": {
			if (!inRange(state.listenPort, 1, 65535)) return false;
			if (state.role !== "encoder") return !!state.srtlaRemoteHost && inRange(state.srtlaRemotePort, 1, 65535);
			return true;
		}
		default:
			return true;
	}
}

function goNext(): void {
	const steps = visibleSteps();
	if (!stepValid(steps[Math.min(state.current, steps.length - 1)].key)) return;
	state.current = Math.min(state.current + 1, steps.length - 1);
	m.redraw();
}

function goPrev(): void {
	state.current = Math.max(state.current - 1, 0);
	m.redraw();
}

// The wizard is served at /d/<id>/, so the viewer socket is "ws" relative to it (settings uses "../ws").
const rpc = new RpcClient(() => socketUrl("ws"));
rpc.on("open", () => {
	state.connected = true;
	m.redraw();
	rpc
		.call<SetupInfo>("setup.get")
		.then((info) => {
			if (!info.required) {
				// device is already configured — the same URL now serves the device page
				location.replace("./");
				return;
			}
			state.hostname = info.hostname;
			state.color = info.color;
			state.language = info.language;
			setLanguage(state.language);
			state.pipelines = info.pipelines;
			state.audioSources = info.audioSources;
			state.loaded = true;
			document.documentElement.style.setProperty("--header-color", state.color);
			state.current = Math.min(state.current, visibleSteps().length - 1);
			m.redraw();
		})
		.catch((error: unknown) => {
			state.message = error instanceof Error ? error.message : String(error);
			m.redraw();
		});
});
rpc.on("close", () => {
	state.connected = false;
	m.redraw();
});

async function complete(): Promise<void> {
	state.saving = true;
	state.message = "";
	m.redraw();
	const { role, hostname, color, language, remoteUrl, remoteToken } = state;
	const payload: Params = { language, role, hostname, color, remoteUrl, remoteToken, autostart: state.autostart };
	if (role !== "relay") {
		Object.assign(payload, {
			pipeline: state.pipeline,
			maxBitrate: num(state.maxBitrate),
			audioSource: state.audioSource,
			audioCodec: state.audioCodec,
			delay: num(state.delay),
			encoderHost: state.encoderHost,
			encoderPort: num(state.encoderPort),
			latency: num(state.latency),
			streamid: state.streamid,
			bitrateOverlay: state.bitrateOverlay,
		});
	}
	if (role !== "encoder") {
		Object.assign(payload, {
			listenPort: num(state.listenPort),
			srtlaRemoteHost: state.srtlaRemoteHost,
			srtlaRemotePort: num(state.srtlaRemotePort),
			srtlaMode: state.srtlaMode,
			srtlaQuality: state.srtlaQuality,
		});
	}
	try {
		await rpc.call("setup.complete", payload);
		state.saved = true;
		state.message = `${t("setup.saved")} ${t("setup.restart_required")}`;
		m.redraw();
	} catch (error: unknown) {
		state.message = error instanceof Error ? error.message : String(error);
	} finally {
		state.saving = false;
		m.redraw();
	}
}

// -- Role card icons -----------------------------------------------------------
const roleIcon = (shape: "encoder" | "relay" | "combined"): m.Vnode =>
	m(
		"svg",
		{
			class: "role-icon",
			viewBox: "0 0 24 24",
			width: "36",
			height: "36",
			fill: "none",
			stroke: "currentColor",
			"stroke-width": "1.6",
			"stroke-linecap": "round",
			"stroke-linejoin": "round",
			"aria-hidden": "true",
		},
		{
			encoder: [m("rect", { x: "2", y: "7", width: "13", height: "10", rx: "2" }), m("path", { d: "m15 11 7-3v8l-7-3z" })],
			relay: [
				m("rect", { x: "1.5", y: "9", width: "7", height: "6", rx: "1.5" }),
				m("rect", { x: "15.5", y: "9", width: "7", height: "6", rx: "1.5" }),
				m("path", { d: "M9 12h6" }),
				m("path", { d: "m13.5 9.5 2.5 2.5-2.5 2.5" }),
				m("path", { d: "m10.5 9.5-2.5 2.5 2.5 2.5" }),
			],
			combined: [
				m("rect", { x: "1.5", y: "8.5", width: "10", height: "7", rx: "1.5" }),
				m("path", { d: "m11.5 11 4-2v4l-4-2z" }),
				m("path", { d: "M17.5 12H23" }),
				m("path", { d: "m21 10 2 2-2 2" }),
			],
		}[shape],
	);

const roleCard = (value: Role, name: string, tagline: string, shape: "encoder" | "relay" | "combined"): m.Vnode =>
	m(
		"label.role-card",
		m("input", {
			type: "radio",
			name: "role",
			value,
			required: true,
			checked: state.role === value,
			onchange: () => {
				state.role = value;
				m.redraw();
			},
		}),
		roleIcon(shape),
		m("span.role-name", name),
		m("span.role-tagline", tagline),
		m("img", { src: "/img/" + shape + ".svg", alt: "", "aria-hidden": "true" })
	);

// -- One fieldset per step -----------------------------------------------------
function stepBody(key: StepKey): m.Vnode {
	switch (key) {
		case "language":
			return m(
				"fieldset.wizard-step",
				{ "data-step": key },
				m("h2.wiz-heading", t("ui.language_label")),
				m("p.wiz-desc", t("setup.language_desc")),
				m(
					"label",
					t("ui.language_label"),
					m(
						"select",
						{
							name: "language",
							value: state.language,
							onchange: (e: Event) => {
								const value = (e.target as HTMLSelectElement).value;
								state.language = value;
								setLanguage(value);
							},
						},
						LANGUAGES.map((l) => m("option", { key: l, value: l }, languageLabel(l))),
					),
				),
			);
		case "role":
			return m(
				"fieldset.wizard-step",
				{ "data-step": key },
				m("h2.wiz-heading", t("set.role")),
				m("p.wiz-desc", t("setup.step.role_sub")),
				roleCard("encoder", t("setup.role.encoder"), t("setup.role.encoder_tag"), "encoder"),
				roleCard("relay", t("setup.step.relay"), t("setup.role.relay_tag"), "relay"),
				roleCard("combined", t("setup.role.combined"), t("setup.role.combined_tag"), "combined"),
			);
		case "identity":
			return m(
				"fieldset.wizard-step",
				{ "data-step": key },
				m("h2.wiz-heading", t("setup.identity")),
				m("p.wiz-desc", t("setup.identity_desc")),
				m(
					"label",
					t("setup.hostname"),
					m("input", {
						name: "hostname",
						required: true,
						pattern: "[A-Za-z0-9][A-Za-z0-9.-]{0,62}",
						title: t("setup.hostname_title"),
						value: state.hostname,
						oninput: (e: Event) => (state.hostname = (e.target as HTMLInputElement).value),
					}),
				),
				m(
					"label",
					t("set.color"),
					m("input", {
						name: "color",
						type: "color",
						value: state.color,
						oninput: (e: Event) => {
							state.color = (e.target as HTMLInputElement).value;
							document.documentElement.style.setProperty("--header-color", state.color);
						},
					}),
				),
			);
		case "control":
			return m(
				"fieldset.wizard-step",
				{ "data-step": key },
				m("h2.wiz-heading", t("setup.step.control")),
				m("p.wiz-desc", t("setup.control_desc")),
				m(
					"label",
					t("set.remote_url"),
					m("input", {
						name: "remoteUrl",
						placeholder: "wss://control.example/device",
						value: state.remoteUrl,
						oninput: (e: Event) => (state.remoteUrl = (e.target as HTMLInputElement).value),
					}),
				),
				m(
					"label",
					t("setup.control_token"),
					m("input", {
						name: "remoteToken",
						type: "password",
						autocomplete: "off",
						value: state.remoteToken,
						oninput: (e: Event) => (state.remoteToken = (e.target as HTMLInputElement).value),
					}),
				),
			);
		case "encoder":
			return m(
				"fieldset.wizard-step",
				{ "data-step": key },
				m("h2.wiz-heading", t("setup.step.encoder")),
				m("p.wiz-desc", t("setup.encoder_desc")),
				m(
					"label",
					t("dev.row.pipeline"),
					m(
						"select",
						{ name: "pipeline", required: true, value: state.pipeline, onchange: (e: Event) => (state.pipeline = (e.target as HTMLSelectElement).value) },
						state.pipelines.map((p) => m("option", { value: p.id }, p.id)),
					),
				),
				m(
					"label",
					t("dev.field.max_bitrate"),
					m("input", {
						name: "maxBitrate",
						type: "number",
						min: 300,
						max: 30000,
						step: 100,
						required: true,
						value: state.maxBitrate,
						oninput: (e: Event) => (state.maxBitrate = (e.target as HTMLInputElement).value),
					}),
				),
				m(
					"label",
					t("dev.field.audio_source"),
					m(
						"select",
						{ name: "audioSource", required: true, value: state.audioSource, onchange: (e: Event) => (state.audioSource = (e.target as HTMLSelectElement).value) },
						state.audioSources.map((a) => m("option", { value: a.id }, a.name)),
					),
				),
				m(
					"label",
					t("dev.field.audio_codec"),
					m(
						"select",
						{ name: "audioCodec", value: state.audioCodec, onchange: (e: Event) => (state.audioCodec = (e.target as HTMLSelectElement).value) },
						m("option", { value: "aac" }, "AAC"),
						m("option", { value: "opus" }, "Opus"),
					),
				),
				m(
					"label",
					t("dev.field.audio_delay"),
					m("input", { name: "delay", type: "number", min: -2000, max: 2000, value: state.delay, oninput: (e: Event) => (state.delay = (e.target as HTMLInputElement).value) }),
				),
				m(
					"label.encoder-target",
					{ hidden: state.role === "combined" },
					t("dev.field.stream_host"),
					m("input", {
						name: "encoderHost",
						placeholder: "192.168.1.10",
						required: state.role === "encoder",
						value: state.encoderHost,
						oninput: (e: Event) => (state.encoderHost = (e.target as HTMLInputElement).value),
					}),
				),
				m(
					"label.encoder-target",
					{ hidden: state.role === "combined" },
					t("dev.field.stream_srt_port"),
					m("input", {
						name: "encoderPort",
						type: "number",
						min: 1,
						max: 65535,
						required: state.role === "encoder",
						value: state.encoderPort,
						oninput: (e: Event) => (state.encoderPort = (e.target as HTMLInputElement).value),
					}),
				),
				m(
					"label",
					t("dev.field.srt_latency"),
					m("input", {
						name: "latency",
						type: "number",
						min: 100,
						max: 10000,
						step: 100,
						required: true,
						value: state.latency,
						oninput: (e: Event) => (state.latency = (e.target as HTMLInputElement).value),
					}),
				),
				m("label", t("dev.field.stream_id"), m("input", { name: "streamid", placeholder: t("ui.optional"), value: state.streamid, oninput: (e: Event) => (state.streamid = (e.target as HTMLInputElement).value) })),
				m(
					"label.check",
					m("input", {
						type: "checkbox",
						name: "bitrateOverlay",
						checked: state.bitrateOverlay,
						onchange: (e: Event) => (state.bitrateOverlay = (e.target as HTMLInputElement).checked),
					}),
					` ${t("dev.field.bitrate_overlay")}`,
				),
			);
		case "relay":
			return m(
				"fieldset.wizard-step",
				{ "data-step": key },
				m("h2.wiz-heading", t("setup.step.relay")),
				m("p.wiz-desc", t("setup.relay_desc")),
				m(
					"label",
					t("dev.field.srt_listen_port"),
					m("input", {
						name: "listenPort",
						type: "number",
						min: 1,
						max: 65535,
						required: true,
						value: state.listenPort,
						oninput: (e: Event) => (state.listenPort = (e.target as HTMLInputElement).value),
					}),
				),
				m(
					"label",
					t("dev.field.remote_host"),
					m("input", {
						name: "srtlaRemoteHost",
						placeholder: "rec.example.com",
						required: state.role !== "encoder",
						value: state.srtlaRemoteHost,
						oninput: (e: Event) => (state.srtlaRemoteHost = (e.target as HTMLInputElement).value),
					}),
				),
				m(
					"label",
					t("dev.field.remote_port"),
					m("input", {
						name: "srtlaRemotePort",
						type: "number",
						min: 1,
						max: 65535,
						required: state.role !== "encoder",
						value: state.srtlaRemotePort,
						oninput: (e: Event) => (state.srtlaRemotePort = (e.target as HTMLInputElement).value),
					}),
				),
				m(
					"label",
					t("dev.scheduler"),
					m(
						"select",
						{
							name: "srtlaMode",
							value: state.srtlaMode,
							onchange: (e: Event) => (state.srtlaMode = (e.target as HTMLSelectElement).value),
						},
						m("option", { value: "enhanced" }, t("dev.scheduler_enhanced")),
						m("option", { value: "classic" }, t("dev.scheduler_classic")),
					),
				),
				m(
					"label.check",
					m("input", {
						type: "checkbox",
						name: "srtlaQuality",
						checked: state.srtlaQuality,
						onchange: (e: Event) => (state.srtlaQuality = (e.target as HTMLInputElement).checked),
					}),
					` ${t("dev.quality_scoring")}`,
				),
			);
		case "finish":
			return m(
				"fieldset.wizard-step",
				{ "data-step": key },
				m("h2.wiz-heading", t("setup.step.review")),
				m("p.wiz-desc", t("setup.review_desc")),
				m(
					"label.check",
					m("input", {
						type: "checkbox",
						name: "autostart",
						checked: state.autostart,
						onchange: (e: Event) => (state.autostart = (e.target as HTMLInputElement).checked),
					}),
					` ${t("setup.autostart")}`,
				),
			);
	}
}

function wizard(): m.Vnode[] {
	const steps = visibleSteps();
	const current = Math.min(state.current, steps.length - 1);
	const last = current === steps.length - 1;
	return [
		m(
			"ol.wizard-stepper",
			{ id: "stepper" },
			steps.map((s, i) =>
				m(
					"li",
					{ key: s.key, class: `wiz-item ${i < current ? "done" : i === current ? "current" : "upcoming"}`, "data-step": s.key },
					m("span.wiz-dot", i < current ? "✓" : String(i + 1)),
					m("span.wiz-title", typeof s.title === "function" ? s.title() : s.title),
					m("span.wiz-sub", typeof s.sub === "function" ? s.sub() : s.sub),
				),
			),
		),
		m(
			"form",
			{ id: "setup-form", onsubmit: (e: Event) => { e.preventDefault(); void complete(); } },
			stepBody(steps[current].key),
			m("div.break"),
			m(
				"div.actions",
				m("button", { type: "button", id: "previous", class: "secondary", hidden: current === 0, onclick: goPrev }, t("ui.back")),
				m("button", { type: "button", id: "next", hidden: last, onclick: goNext }, t("ui.next")),
				m("button", { type: "submit", id: "complete", hidden: !last, disabled: state.saving }, t("setup.save")),
			),
		),
		m("p.muted", { id: "result", role: "status" }, state.saved ? state.message : state.message),
	];
}

const App: m.Component<{}, {}> = {
	view: () =>
		m(
			Page,
			{ title: t("setup.title"), headerRight: badge(state.connected ? t("dev.connected") : t("dev.disconnected"), state.connected ? "on" : "off") },
			m("section.card", null, state.loaded ? wizard() : m("p.muted", t("setup.loading"))),
		),
};

document.title = t("setup.title");
m.mount(byId("app"), App);
