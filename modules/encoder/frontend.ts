/* Encoder card: status rows, the stream form and (on ceracoder devices) bitrate control. */
import m from "mithril";
import type { CeraBalancer, Pipeline, Status } from "../../public/types";
import { BITRATE_KBPS } from "../../public/types";
import {
	actions,
	audioCodecOptions,
	badge,
	brk,
	button,
	Card,
	type Child,
	checkbox,
	checkField,
	definitionList,
	encoderIssueBadge,
	field,
	fieldGroup,
	form,
	input,
	numberAttrs,
	options,
	select,
} from "../../public/ts/components/ui";
import { t } from "../../public/ts/i18n";
import { optionalNumber, since } from "../../public/ts/util";
import { card, type DeviceCard } from "../../public/ts/device/store";
import type { BrowserModule } from "../types";

// ----------------------------------------------------------------------
// ceracoder bitrate control
// ----------------------------------------------------------------------
type Param = readonly [key: string, labelKey: string, attrs: m.Attributes];
const BITRATE_ATTRS = (placeholder: string) => numberAttrs(BITRATE_KBPS.min, BITRATE_KBPS.max, placeholder, 100);
const STEP = (placeholder: string) => numberAttrs(1, 10000, placeholder);
const INTERVAL = (placeholder: string) => numberAttrs(10, 60000, placeholder);
const CERA_PARAMS: Record<Exclude<CeraBalancer, "fixed">, readonly Param[]> = {
	adaptive: [
		["incrStep", "dev.field.cera_incr_step", STEP("30")],
		["decrStep", "dev.field.cera_decr_step", STEP("100")],
		["incrInterval", "dev.field.cera_incr_interval", INTERVAL("500")],
		["decrInterval", "dev.field.cera_decr_interval", INTERVAL("200")],
	],
	aimd: [
		["incrStep", "dev.field.cera_incr_step", STEP("50")],
		["decrMult", "dev.field.cera_decr_mult", numberAttrs(0, 1, "0.75", 0.01)],
		["incrInterval", "dev.field.cera_incr_interval", INTERVAL("500")],
		["decrInterval", "dev.field.cera_decr_interval", INTERVAL("200")],
	],
};

const numbers = (group: Record<string, string>) =>
	Object.fromEntries(Object.entries(group).map(([k, v]) => [k, optionalNumber(v)]));

function ceracoderControls(host: DeviceCard): m.Children {
	const { cera, touched } = host;
	const group = cera.balancer === "fixed" ? null : cera.balancer;
	return fieldGroup(
		t("dev.cera_section"),
		field(
			t("dev.field.balancer"),
			select(
				cera,
				"balancer",
				options((["adaptive", "fixed", "aimd"] as const).map((b) => [b, t(`dev.balancer.${b}`)])),
				{},
				() => touched.add("balancer"),
			),
		),
		brk(),
		group &&
			CERA_PARAMS[group].map(([key, labelKey, attrs]) =>
				field(t(labelKey), input(cera[group] as Record<string, string>, key, { ...attrs, name: `${group}.${key}` }), {
					key: `${group}.${key}`,
				}),
			),		
		actions(
			button(t("dev.apply_cera"), {
				class: "secondary",
				disabled: !host.enabled("ceracoder-apply"),
				onclick: () =>
					host.press("ceracoder-apply", "ceracoder.set", {
						balancer: cera.balancer,
						adaptive: numbers(cera.adaptive),
						aimd: numbers(cera.aimd),
					}),
			}),
		),
	);
}

// ----------------------------------------------------------------------
// Card
// ----------------------------------------------------------------------
const stateBadge = ({ role, state: { encoder, srtla } }: Status): m.Vnode =>
	encoderIssueBadge(role, encoder, srtla) ?? badge(t("dev.badge.streaming"), "on");

function pipelineOptions(host: DeviceCard): m.Children {
	const groups = new Map<string, Pipeline[]>();
	for (const p of host.st.pipelines) groups.set(p.group, [...(groups.get(p.group) ?? []), p]);
	if (!groups.size)
		return m("option", { value: "", disabled: true }, `${t("dev.no_pipelines", host.st.pipelineDir)} ${t("dev.no_pipelines_hint")}`);
	return [...groups].map(([group, list]) => {
		const opts = options(list.map((p) => [p.id, p.name]));
		return group ? m("optgroup", { key: group, label: group }, opts) : m.fragment({ key: "" }, opts);
	});
}

function statusRows(host: DeviceCard, status: Status): [string, Child][] {
	const { encoder: e } = status.state;
	const cfg = e.config;
	const combined = status.role === "combined";
	const audioName = status.audioSources.find((a) => a.id === host.fields.audioSource)?.name;
	return [
		[t("dev.row.state"), stateBadge(status)],
		[t("dev.row.encoder"), status.ceracoder ? "ceracoder" : "belacoder"],
		[t("dev.row.pipeline"), cfg?.pipeline],
		// Combined devices stream into their own srtla_send, so the target row is hidden for them
		...(combined ? [] : [[t("dev.row.target"), e.running && cfg ? `${cfg.host}:${cfg.port}` : null] as [string, Child]]),
		[
			t("dev.row.bitrate"),
			cfg && t("dev.minmax_kbps", cfg.minBitrate ?? status.ceracoder?.minBitrate ?? BITRATE_KBPS.min, cfg.maxBitrate),
		],
		[t("dev.row.latency"), cfg && t("dev.latency_audio", cfg.latency, cfg.delay)],
		[
			t("dev.row.audio"),
			cfg &&
				`${audioName ?? cfg.audioSource ?? t("dev.audio_pipeline_default")}, ${(cfg.audioCodec ?? "aac").toUpperCase()}`,
		],
		[t("dev.row.started"), e.running ? since(e.startedAt) : null],
		[t("dev.row.restarts"), e.running ? (e.restarts ?? 0) : null],
	];
}

export function encoderCardBody(host: DeviceCard, status: Status): m.Vnode {
	const { fields, touched } = host;
	const combined = status.role === "combined";
	const pipeline = host.selectedPipeline();
	return m(
		Card,
		{ title: t("dev.card.encoder"), class: "mod-encoder" },
		definitionList(statusRows(host, status)),
		form(
			{ onSubmit: host.encoderStart },
			fieldGroup(
				t("dev.group.video"),
				field(
					t("dev.row.pipeline"),
					select(fields, "pipeline", pipelineOptions(host), { required: true }, () => touched.add("pipeline")),
				),
				pipeline?.overlay &&
					checkField(
						t("dev.field.bitrate_overlay"),
						checkbox(fields, "bitrateOverlay", {}, () => touched.add("bitrateOverlay")),
					),
			),
			fieldGroup(
				t("dev.group.bitrate"),
				field(t("dev.field.min_bitrate"), input(fields, "minBitrate", BITRATE_ATTRS(String(BITRATE_KBPS.min)))),
				field(
					t("dev.field.max_bitrate"),
					actions(
						input(fields, "maxBitrate", BITRATE_ATTRS("5000")),
						button(t("dev.apply_bitrate"), {
							class: "secondary",
							disabled: !host.enabled("encoder-bitrate"),
							onclick: () =>
								host.press("encoder-bitrate", "encoder.bitrate", {
									minBitrate: optionalNumber(fields.minBitrate),
									maxBitrate: optionalNumber(fields.maxBitrate),
								}),
						}),
					),
				),
			),
			status.ceracoder && ceracoderControls(host),
			fieldGroup(
				t("dev.group.audio"),
				pipeline?.asrc &&
					field(
						t("dev.field.audio_source"),
						select(
							fields,
							"audioSource",
							options(status.audioSources.map((a) => [a.id, a.name])),
							{},
							() => touched.add("audioSource"),
						),
					),
				pipeline?.acodec &&
					field(
						t("dev.field.audio_codec"),
						select(fields, "audioCodec", audioCodecOptions(), {}, () => touched.add("audioCodec")),
					),
				field(t("dev.field.audio_delay"), input(fields, "delay", numberAttrs(-2000, 2000, "0"))),
			),
			fieldGroup(
				t("dev.group.srt"),
				!combined && [
					field(t("dev.field.stream_host"), input(fields, "encHost", { placeholder: "192.168.1.10", required: true })),
					field(t("dev.field.stream_srt_port"), input(fields, "encPort", { placeholder: "6000", required: true })),
					brk(),
				],
				field(t("dev.field.srt_latency"), input(fields, "latency", numberAttrs(100, 10000, "2000", 100))),
				field(t("dev.field.stream_id"), input(fields, "streamid", { placeholder: t("ui.optional") })),
			),
			!combined && [brk(), host.streamButtons("encoder.stop")],
		),
	);
}


export const encoderModule: BrowserModule = {
	id: "encoder",
	title: "Encoder",
	defaultSize: { w: 6, h: 5 },
	minSize: { w: 4, h: 4 },
	component: (status: Status) => encoderCardBody(card, status),
};
