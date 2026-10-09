/* First-run setup wizard — a Mithril view: stepper, one fieldset per step,
 * Back / Next / Save controls, all driven by a single state object. */
import m from "mithril";
import { errorMessage } from "../../src/util";
import { BITRATE_KBPS, DEFAULT_COLOR, HOSTNAME_RE } from "../../src/validate";
import type { AudioSource, Pipeline, Role } from "../types";
import {
	actions,
	audioCodecOptions,
	brk,
	button,
	checkbox,
	checkField,
	connectionBadge,
	field,
	form,
	input,
	numberAttrs,
	options,
	Page,
	schedulerOptions,
	select,
} from "./components/ui";
import { languageOptions, setLanguage, t } from "./i18n";
import { roleCardIcon } from "./icons";
import { RpcClient, socketUrl } from "./services/rpc";
import { HOSTNAME_PATTERN, inRange, mountPage, setHeaderColor, toNumber } from "./util";

interface SetupInfo {
	required: boolean;
	hostname: string;
	color: string;
	language: string;
	pipelines: Pipeline[];
	audioSources: AudioSource[];
}

type StepKey = "language" | "role" | "identity" | "control" | "encoder" | "relay" | "finish";

/** Stepper entries: translation keys of each step's title and subtitle. */
const STEPS: { key: StepKey; title: string; sub: string }[] = [
	{ key: "language", title: "ui.language_label", sub: "setup.step.language_sub" },
	{ key: "role", title: "set.role", sub: "setup.step.role_sub" },
	{ key: "identity", title: "setup.step.identity", sub: "setup.step.identity_sub" },
	{ key: "control", title: "setup.step.control", sub: "setup.step.control_sub" },
	{ key: "encoder", title: "setup.step.encoder", sub: "setup.step.encoder_sub" },
	{ key: "relay", title: "setup.step.relay", sub: "setup.step.relay_sub" },
	{ key: "finish", title: "setup.step.review", sub: "setup.save" },
];

const PORT = numberAttrs(1, 65535);
const BITRATE = { ...numberAttrs(BITRATE_KBPS.min, BITRATE_KBPS.max, undefined, 100), required: true };
const bitrateValid = (v: string) => inRange(v, BITRATE_KBPS.min, BITRATE_KBPS.max);

const state = {
	connected: false,
	loaded: false,
	current: 0,
	message: "",
	saving: false,
	pipelines: [] as Pipeline[],
	audioSources: [] as AudioSource[],
};

/** The answers, sent as-is (numbers converted) to `setup.complete`. */
const f = {
	language: "en",
	role: undefined as Role | undefined,
	hostname: "",
	color: DEFAULT_COLOR,
	remoteUrl: "",
	remoteToken: "",
	// encoder / combined
	pipeline: "",
	minBitrate: String(BITRATE_KBPS.min),
	maxBitrate: "5000",
	audioSource: "",
	audioCodec: "aac",
	delay: "0",
	encoderHost: "",
	encoderPort: "6000",
	latency: "2000",
	streamid: "",
	bitrateOverlay: false,
	// relay / combined
	listenPort: "6000",
	srtlaRemoteHost: "",
	srtlaRemotePort: "5000",
	srtlaMode: "enhanced",
	srtlaQuality: true,
	autostart: false,
};

// A step applies only for roles where it makes sense
const visibleSteps = () =>
	STEPS.filter(({ key }) => (key === "encoder" ? f.role !== "relay" : key === "relay" ? f.role !== "encoder" : true));

/** A step passes when every mandatory field in it is satisfied (the same rules as the
 * native `required`/min/max constraints on its inputs). */
function stepValid(key: StepKey): boolean {
	switch (key) {
		case "role":
			return !!f.role;
		case "identity":
			return HOSTNAME_RE.test(f.hostname);
		case "encoder":
			return (
				!!f.pipeline &&
				!!f.audioSource &&
				bitrateValid(f.minBitrate) &&
				bitrateValid(f.maxBitrate) &&
				Number(f.minBitrate) <= Number(f.maxBitrate) &&
				inRange(f.latency, 100, 10000) &&
				(f.role !== "encoder" || (!!f.encoderHost && inRange(f.encoderPort, 1, 65535)))
			);
		case "relay":
			return (
				inRange(f.listenPort, 1, 65535) &&
				(f.role === "encoder" || (!!f.srtlaRemoteHost && inRange(f.srtlaRemotePort, 1, 65535)))
			);
		default:
			return true;
	}
}

const currentIndex = () => Math.min(state.current, visibleSteps().length - 1);

function goNext(): void {
	const steps = visibleSteps();
	const current = currentIndex();
	if (stepValid(steps[current].key)) state.current = Math.min(current + 1, steps.length - 1);
}

function goPrev(): void {
	state.current = Math.max(currentIndex() - 1, 0);
}

// The wizard is served at /d/<id>/, so the viewer socket is "ws" relative to it (settings uses "../ws").
const rpc = new RpcClient(() => socketUrl("ws"));
rpc.on("open", async () => {
	state.connected = true;
	m.redraw();
	try {
		const info = await rpc.call<SetupInfo>("setup.get");
		if (!info.required) {
			// device is already configured — the same URL now serves the device page
			location.replace("./");
			return;
		}
		Object.assign(f, { hostname: info.hostname, color: info.color, language: info.language });
		setLanguage(info.language);
		setHeaderColor(info.color);
		state.pipelines = info.pipelines;
		state.audioSources = info.audioSources;
		state.loaded = true;
	} catch (error: unknown) {
		state.message = errorMessage(error);
	}
	m.redraw();
});
rpc.on("close", () => {
	state.connected = false;
	m.redraw();
});

async function complete(): Promise<void> {
	state.saving = true;
	state.message = "";
	const { language, role, hostname, color, remoteUrl, remoteToken, autostart } = f;
	const payload: Record<string, unknown> = { language, role, hostname, color, remoteUrl, remoteToken, autostart };
	if (role !== "relay") {
		Object.assign(payload, {
			pipeline: f.pipeline,
			minBitrate: toNumber(f.minBitrate),
			maxBitrate: toNumber(f.maxBitrate),
			audioSource: f.audioSource,
			audioCodec: f.audioCodec,
			delay: toNumber(f.delay),
			encoderHost: f.encoderHost,
			encoderPort: toNumber(f.encoderPort),
			latency: toNumber(f.latency),
			streamid: f.streamid,
			bitrateOverlay: f.bitrateOverlay,
		});
	}
	if (role !== "encoder") {
		Object.assign(payload, {
			listenPort: toNumber(f.listenPort),
			srtlaRemoteHost: f.srtlaRemoteHost,
			srtlaRemotePort: toNumber(f.srtlaRemotePort),
			srtlaMode: f.srtlaMode,
			srtlaQuality: f.srtlaQuality,
		});
	}
	try {
		await rpc.call("setup.complete", payload);
		state.message = `${t("setup.saved")} ${t("setup.restart_required")}`;
		// Reconnect: setup.get then reports the device configured and the page moves on to the device UI
		rpc.reconnect();
	} catch (error: unknown) {
		state.message = errorMessage(error);
	} finally {
		state.saving = false;
		m.redraw();
	}
}

// -- One fieldset per step -----------------------------------------------------
const step = (key: StepKey, heading: string, desc: string, ...children: m.Children[]) => (
	<fieldset class={"wizard-step"} data-step={key}>
		<h2 class={"wiz-heading"}>{heading}</h2>
		<p class={"wiz-desc"}>{desc}</p>
		{children}
	</fieldset>
);

const roleCard = (value: Role, name: string, tagline: string): m.Vnode => (
	<label class={"role-card"}>
		<input
			type={"radio"}
			name={"role"}
			value={value}
			required={true}
			checked={f.role === value}
			onchange={() => (f.role = value)}
		/>
		{roleCardIcon(value)}
		<span class={"role-name"}>{name}</span>
		<span class={"role-tagline"}>{tagline}</span>
		<img src={`/img/${value}.svg`} alt={""} aria-hidden={"true"} />
	</label>
);

const check = (key: "bitrateOverlay" | "srtlaQuality" | "autostart", label: string) =>
	checkField(null, [checkbox(f, key), ` ${label}`]);

function stepBody(key: StepKey): m.Vnode {
	switch (key) {
		case "language":
			return step(
				key,
				t("ui.language_label"),
				t("setup.language_desc"),
				field(t("ui.language_label"), select(f, "language", languageOptions(), {}, setLanguage)),
			);
		case "role":
			return step(
				key,
				t("set.role"),
				t("setup.step.role_sub"),
				roleCard("encoder", t("setup.role.encoder"), t("setup.role.encoder_tag")),
				roleCard("relay", t("setup.step.relay"), t("setup.role.relay_tag")),
				roleCard("combined", t("setup.role.combined"), t("setup.role.combined_tag")),
			);
		case "identity":
			return step(
				key,
				t("setup.identity"),
				t("setup.identity_desc"),
				field(
					t("setup.hostname"),
					input(f, "hostname", {
						required: true,
						pattern: HOSTNAME_PATTERN,
						title: t("setup.hostname_title"),
					}),
				),
				field(t("set.color"), input(f, "color", { type: "color" }, setHeaderColor)),
			);
		case "control":
			return step(
				key,
				t("setup.step.control"),
				t("setup.control_desc"),
				field(t("set.remote_url"), input(f, "remoteUrl", { placeholder: "wss://control.example/device" })),
				field(t("setup.control_token"), input(f, "remoteToken", { type: "password", autocomplete: "off" })),
			);
		case "encoder": {
			const standalone = f.role === "encoder";
			return step(
				key,
				t("setup.step.encoder"),
				t("setup.encoder_desc"),
				field(
					t("dev.row.pipeline"),
					select(f, "pipeline", options(state.pipelines.map((p) => [p.id, p.id])), { required: true }),
				),
				field(t("dev.field.min_bitrate"), input(f, "minBitrate", BITRATE)),
				field(t("dev.field.max_bitrate"), input(f, "maxBitrate", BITRATE)),
				field(
					t("dev.field.audio_source"),
					select(f, "audioSource", options(state.audioSources.map((a) => [a.id, a.name])), {
						required: true,
					}),
				),
				field(t("dev.field.audio_codec"), select(f, "audioCodec", audioCodecOptions())),
				field(t("dev.field.audio_delay"), input(f, "delay", numberAttrs(-2000, 2000))),
				// Combined devices stream into their own srtla_send: no target to configure
				standalone && [
					field(
						t("dev.field.stream_host"),
						input(f, "encoderHost", { placeholder: "192.168.1.10", required: true }),
					),
					field(t("dev.field.stream_srt_port"), input(f, "encoderPort", { ...PORT, required: true })),
				],
				field(
					t("dev.field.srt_latency"),
					input(f, "latency", { ...numberAttrs(100, 10000, undefined, 100), required: true }),
				),
				field(t("dev.field.stream_id"), input(f, "streamid", { placeholder: t("ui.optional") })),
				check("bitrateOverlay", t("dev.field.bitrate_overlay")),
			);
		}
		case "relay": {
			const needsReceiver = f.role !== "encoder";
			return step(
				key,
				t("setup.step.relay"),
				t("setup.relay_desc"),
				field(t("dev.field.srt_listen_port"), input(f, "listenPort", { ...PORT, required: true })),
				field(
					t("dev.field.remote_host"),
					input(f, "srtlaRemoteHost", { placeholder: "rec.example.com", required: needsReceiver }),
				),
				field(t("dev.field.remote_port"), input(f, "srtlaRemotePort", { ...PORT, required: needsReceiver })),
				field(t("dev.scheduler"), select(f, "srtlaMode", schedulerOptions())),
				check("srtlaQuality", t("dev.quality_scoring")),
			);
		}
		case "finish":
			return step(key, t("setup.step.review"), t("setup.review_desc"), check("autostart", t("setup.autostart")));
	}
}

function wizard(): m.Children {
	const steps = visibleSteps();
	const current = currentIndex();
	const last = current === steps.length - 1;
	const stage = (i: number) => (i < current ? "done" : i === current ? "current" : "upcoming");
	return [
		<ol class={"wizard-stepper"}>
			{steps.map((s, i) => (
				<li key={s.key} class={`wiz-item ${stage(i)}`} data-step={s.key}>
					<span class={"wiz-dot"}>{i < current ? "✓" : String(i + 1)}</span>
					<span class={"wiz-title"}>{t(s.title)}</span>
					<span class={"wiz-sub"}>{t(s.sub)}</span>
				</li>
			))}
		</ol>,
		form(
			{ id: "setup-form", onSubmit: complete },
			stepBody(steps[current].key),
			brk(),
			actions(
				button(t("ui.back"), { class: "secondary", hidden: current === 0, onclick: goPrev }),
				button(t("ui.next"), { hidden: last, onclick: goNext }),
				button(t("setup.save"), { type: "submit", hidden: !last, disabled: state.saving }),
			),
		),
		<p class={"muted"} role={"status"}>
			{state.message}
		</p>,
	];
}

const App: m.Component = {
	view: () => (
		<Page title={t("setup.title")} headerRight={connectionBadge(state.connected)}>
			<section class={"card"}>{state.loaded ? wizard() : <p class={"muted"}>{t("setup.loading")}</p>}</section>
		</Page>
	),
};

void mountPage(() => t("setup.title"), App);
