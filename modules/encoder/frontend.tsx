/* Encoder card: status rows, the stream form and (on ceracoder devices) bitrate control. */
import m from "mithril";
import type { CeraBalancer, Pipeline, Status } from "../../public/types";
import { BITRATE_KBPS } from "../../public/types";
import {
	Actions,
	AudioCodecOptions,
	Badge,
	Break,
	Button,
	Card,
	type Child,
	Checkbox,
	CheckField,
	DefinitionList,
	EncoderIssueBadge,
	Field,
	FieldGroup,
	Form,
	hasEncoderIssue,
	Input,
	numberAttrs,
	Options,
	Select,
} from "../../public/ts/components/ui";
import { t } from "../../public/ts/i18n";
import { optionalNumber, since } from "../../public/ts/util";
import { card, type DeviceCard } from "../../public/ts/device/store";
import type { BridgedModule } from "./types";

// ----------------------------------------------------------------------
// Stream control (owns the encoder + stream start logic, shared with SRTLA)
// ----------------------------------------------------------------------

/** The pipeline currently selected in the form (or the default one). */
export function selectedPipeline(host: DeviceCard): Pipeline | undefined {
	return host.st.pipelines.find((p) => p.id === host.fields.pipeline);
}

/** Submit the encoder / stream form: the chosen pipeline, bitrate, audio and target. */
export function encoderStart(host: DeviceCard): void {
	const status = host.st.status;
	const { fields, press } = host;
	if (!status) return;
	const pipeline = selectedPipeline(host);
	const common = {
		pipeline: fields.pipeline,
		minBitrate: optionalNumber(fields.minBitrate),
		maxBitrate: optionalNumber(fields.maxBitrate),
		latency: optionalNumber(fields.latency),
		delay: optionalNumber(fields.delay),
		streamid: fields.streamid || undefined,
		// Options the selected pipeline does not support are hidden; do not send their stale values
		audioSource: pipeline?.asrc ? fields.audioSource || undefined : "default",
		audioCodec: pipeline?.acodec ? fields.audioCodec || undefined : undefined,
		bitrateOverlay: pipeline?.overlay ? fields.bitrateOverlay : false,
	};
	if (status.role === "combined") {
		if (!fields.remoteHost || !fields.remotePort) return;
		press("encoder-start", "stream.start", { ...common, remoteHost: fields.remoteHost, remotePort: fields.remotePort });
	} else {
		if (!fields.encHost || !fields.encPort) return;
		press("encoder-start", "encoder.start", { ...common, host: fields.encHost, port: fields.encPort });
	}
}

/** Start / Stop buttons for a stream (encoder card, or the SRTLA card of a combined device). */
export function streamButtons(host: DeviceCard, stopMethod: string): m.Children {
	return (
		<Actions>
			<Button
				label={t("ui.start")}
				type={"submit"}
				disabled={!host.enabled("encoder-start")}
			/>
			<Button
				label={t("ui.stop")}
				class={"danger"}
				disabled={!host.enabled("encoder-stop")}
				onclick={() => host.press("encoder-stop", stopMethod)}
			/>
		</Actions>
	);
}

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
		["incrMult", "dev.field.cera_incr_mult", numberAttrs(0, 1, "0.75", 0.01)],
		["incrInterval", "dev.field.cera_incr_interval", INTERVAL("500")],
		["decrInterval", "dev.field.cera_decr_interval", INTERVAL("200")],
	],
};

const numbers = (group: Record<string, string>) =>
	Object.fromEntries(Object.entries(group).map(([k, v]) => [k, optionalNumber(v)]));

function ceracoderControls(host: DeviceCard): m.Children {
	const { cera, touched } = host;
	const group = cera.balancer === "fixed" ? null : cera.balancer;
	return (
		<FieldGroup legend={t("dev.cera_section")}>
			<Field
				label={t("dev.field.balancer")}
				control={
					<Select target={cera} prop="balancer" onChange={() => touched.add("balancer")}>
						<Options
							pairs={(["adaptive", "fixed", "aimd"] as const).map((b) => [b, t(`dev.balancer.${b}`)])}
						/>
					</Select>
				}
			/>
			<Break />
			{group &&
				CERA_PARAMS[group].map(([key, labelKey, attrs]) => (
					<Field
						key={`${group}.${key}`}
						label={t(labelKey)}
						control={
							<Input
								target={cera[group] as Record<string, string>}
								prop={key}
								{...attrs}
								name={`${group}.${key}`}
							/>
						}
					/>
				))}
			<Actions>
				<Button
					label={t("dev.apply_cera")}
					class={"secondary"}
					disabled={!host.enabled("ceracoder-apply")}
					onclick={() =>
						host.press("ceracoder-apply", "ceracoder.set", {
							balancer: cera.balancer,
							adaptive: numbers(cera.adaptive),
							aimd: numbers(cera.aimd),
						})
					}
				/>
			</Actions>
		</FieldGroup>
	);
}

// ----------------------------------------------------------------------
// Card
// ----------------------------------------------------------------------
const stateBadge = ({ role, state: { encoder, srtla } }: Status): m.Vnode =>
	hasEncoderIssue(role, encoder, srtla) ? (
		<EncoderIssueBadge role={role} e={encoder} srtla={srtla} />
	) : (
		<Badge text={t("dev.badge.streaming")} kind={"on"} />
	);

function pipelineOptions(host: DeviceCard): m.Children {
	const groups = new Map<string, Pipeline[]>();
	for (const p of host.st.pipelines) groups.set(p.group, [...(groups.get(p.group) ?? []), p]);
	if (!groups.size)
		return (
			<option
				value={""}
				disabled={true}
			>{`${t("dev.no_pipelines", host.st.pipelineDir)} ${t("dev.no_pipelines_hint")}`}</option>
		);
	return [...groups].map(([group, list]) => {
		const opts = <Options pairs={list.map((p) => [p.id, p.name])} />;
		return group ? (
			<optgroup key={group} label={group}>
				{opts}
			</optgroup>
		) : (
			opts
		);
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
		...(combined
			? []
			: [[t("dev.row.target"), e.running && cfg ? `${cfg.host}:${cfg.port}` : null] as [string, Child]]),
		[
			t("dev.row.bitrate"),
			cfg &&
				t(
					"dev.minmax_kbps",
					cfg.minBitrate ?? status.ceracoder?.minBitrate ?? BITRATE_KBPS.min,
					cfg.maxBitrate,
				),
		],
		[t("dev.row.latency"), cfg && t("dev.latency_audio", cfg.latency, cfg.delay)],
		[
			t("dev.row.audio"),
			cfg &&
				`${audioName ?? cfg.audioSource ?? t("dev.audio_pipeline_default")}, ${(cfg.audioCodec ?? "aac").toUpperCase()}`,
		],
		[t("dev.row.started"), e.running ? since(e.startedAt) : null],
		[t("dev.row.restarts"), e.running ? e.restarts ?? 0 : null],
	];
}

export function encoderCardBody(host: DeviceCard, status: Status): m.Vnode {
	const { fields, touched } = host;
	const combined = status.role === "combined";
	const pipeline = selectedPipeline(host);
	return (
		<Card title={t("dev.card.encoder")} class={"mod-encoder"}>
			<DefinitionList rows={statusRows(host, status)} />
			<Form onSubmit={() => encoderStart(host)}>
				<FieldGroup legend={t("dev.group.video")}>
					<Field
						label={t("dev.row.pipeline")}
						control={
							<Select target={fields} prop="pipeline" required={true} onChange={() => touched.add("pipeline")}>
								{pipelineOptions(host)}
							</Select>
						}
					/>
					{pipeline?.overlay && (
						<CheckField
							label={t("dev.field.bitrate_overlay")}
							control={
								<Checkbox
									target={fields}
									prop="bitrateOverlay"
									onChange={() => touched.add("bitrateOverlay")}
								/>
							}
						/>
					)}
				</FieldGroup>
				<FieldGroup legend={t("dev.group.bitrate")}>
					<Field label={t("dev.field.min_bitrate")} control={<Input target={fields} prop="minBitrate" {...BITRATE_ATTRS(String(BITRATE_KBPS.min))} />} />
					<Field
						label={t("dev.field.max_bitrate")}
						control={
							<span class={"actions"}>
								<Input target={fields} prop="maxBitrate" {...BITRATE_ATTRS("5000")} />
								<Button
									label={t("dev.apply_bitrate")}
									class={"secondary"}
									disabled={!host.enabled("encoder-bitrate")}
									onclick={() =>
										host.press("encoder-bitrate", "encoder.bitrate", {
											minBitrate: optionalNumber(fields.minBitrate),
											maxBitrate: optionalNumber(fields.maxBitrate),
										})
									}
								/>
							</span>
						}
					/>
				</FieldGroup>
				{status.ceracoder && ceracoderControls(host)}
				<FieldGroup legend={t("dev.group.audio")}>
					{pipeline?.asrc && (
						<Field
							label={t("dev.field.audio_source")}
							control={
								<Select
									target={fields}
									prop="audioSource"
									onChange={() => touched.add("audioSource")}
								>
									<Options pairs={status.audioSources.map((a) => [a.id, a.name])} />
								</Select>
							}
						/>
					)}
					{pipeline?.acodec && (
						<Field
							label={t("dev.field.audio_codec")}
							control={
								<Select target={fields} prop="audioCodec" onChange={() => touched.add("audioCodec")}>
									<AudioCodecOptions />
								</Select>
							}
						/>
					)}
					<Field label={t("dev.field.audio_delay")} control={<Input target={fields} prop="delay" {...numberAttrs(-2000, 2000, "0")} />} />
				</FieldGroup>
				<FieldGroup legend={t("dev.group.srt")}>
					{!combined && (
						<>
							<Field
								label={t("dev.field.stream_host")}
								control={<Input target={fields} prop="encHost" placeholder={"192.168.1.10"} required={true} />}
							/>
							<Field
								label={t("dev.field.stream_srt_port")}
								control={<Input target={fields} prop="encPort" placeholder={"6000"} required={true} />}
							/>
							<Break />
						</>
					)}
					<Field
						label={t("dev.field.srt_latency")}
						control={<Input target={fields} prop="latency" {...numberAttrs(100, 10000, "2000", 100)} />}
					/>
					<Field
						label={t("dev.field.stream_id")}
						control={<Input target={fields} prop="streamid" placeholder={t("ui.optional")} />}
					/>
				</FieldGroup>
				{!combined && [
					<Break />,
					streamButtons(host, "encoder.stop"),
				]}
			</Form>
		</Card>
	);
}

const encoderModule: BridgedModule = {
	id: "encoder",
	kind: "device-card",
	title: "Encoder",
	defaultSize: { w: 6, h: 5 },
	minSize: { w: 4, h: 4 },
	component: (status: Status) => encoderCardBody(card, status),
	cardBody: (host, status) => encoderCardBody(host as DeviceCard, status as Status),
};

export default encoderModule;
