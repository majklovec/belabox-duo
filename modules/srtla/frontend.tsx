/* SRTLA card: srtla_send state, the receiver form and the scheduler options. */
import m from "mithril";
import type { ServerDashboardWidget, Status, SrtlaStats } from "../../public/types";
import {
	Actions,
	Badge,
	Break,
	Button,
	Card,
	type Child,
	CheckField,
	DefinitionList,
	Field,
	FieldGroup,
	Form,
	Input,
	SchedulerOptions,
} from "../../public/ts/components/ui";
import { formatBitrate, since } from "../../public/ts/util";
import { t } from "../../public/ts/i18n";
import { card, type DeviceCard } from "../../public/ts/device/store";
import { encoderStart, streamButtons } from "../encoder/frontend";
import type { BridgedModule, ChannelWidgetModule, WidgetContext } from "./types";

type SrtlaOptions = Status["state"]["srtlaOptions"];

function srtlaStart(host: DeviceCard): void {
	const { fields } = host;
	if (!fields.listenPort || !fields.remoteHost || !fields.remotePort) return;
	host.press("srtla-start", "srtla.start", {
		listenPort: fields.listenPort,
		remoteHost: fields.remoteHost,
		remotePort: fields.remotePort,
	});
}

async function setOption(host: DeviceCard, key: keyof SrtlaOptions, value: string | boolean): Promise<void> {
	const result = await host.act<{ options: SrtlaOptions }>(`srtla-${key}`, "srtla.options", { [key]: value });
	// The status push is debounced; do not flash the old value until it arrives
	if (result && host.st.status) host.st.status.state.srtlaOptions = result.options;
}

// Scheduler options: the saved settings, else what the running srtla_send reports, else its defaults
const liveStats = (host: DeviceCard) => (host.st.status?.state.srtla.running ? host.st.stats : null);
const modeValue = (host: DeviceCard): string =>
	host.st.status?.state.srtlaOptions?.mode ?? liveStats(host)?.mode ?? "enhanced";
const qualityValue = (host: DeviceCard): boolean =>
	host.st.status?.state.srtlaOptions?.quality ?? liveStats(host)?.quality_enabled ?? true;

function controlBadge(status: Status): Child {
	const c = status.srtlaControl;
	if (c?.connected) return <Badge text={t("dev.connected")} kind={"on"} />;
	if (c?.supported) return <Badge text={t("dev.control_connecting")} kind={"warn"} />;
	return (
		<span class={"muted"} title={t("dev.control_unavailable_title")}>
			{t("dev.control_unavailable")}
		</span>
	);
}

export function srtlaCardBody(host: DeviceCard, status: Status): m.Vnode {
	const { fields, busy } = host;
	const s = status.state.srtla;
	const combined = status.role === "combined";
	return (
		<Card title={t("dev.card.srtla")} class={"mod-srtla"}>
			<DefinitionList
				rows={[
					[
						t("dev.row.state"),
						s.running ? <Badge text={t("dev.row_state_running")} kind={"on"} /> : <Badge text={t("dev.badge.stopped")} kind={"off"} />,
					],
					[t("dev.row.started"), s.running ? since(s.startedAt) : null],
					[
						t("dev.reloads"),
						t("dev.reloads_detail", s.reloadCount ?? 0, since(s.lastReloadAt), status.monitor.reloadMode),
					],
					[
						t("dev.monitor"),
						status.monitor.running ? <Badge text={t("dev.monitor_watching")} kind={"on"} /> : <Badge text={t("ui.off")} kind={"warn"} />,
					],
					[t("dev.control"), s.running ? controlBadge(status) : null],
				]}
			/>
			<Form onSubmit={combined ? () => encoderStart(host) : () => srtlaStart(host)}>
				<FieldGroup legend={t("dev.group.connection")}>
					{!combined && (
						<>
							<Field
								label={t("dev.field.srt_listen_port")}
								control={<Input target={fields} prop="listenPort" placeholder={"6000"} required={true} />}
							/>
							<span> ⇨ </span>
						</>
					)}
					<Field
						label={t("dev.field.remote_host")}
						control={<Input target={fields} prop="remoteHost" placeholder={"rec.example.com"} required={true} />}
					/>
					<Field
						label={t("dev.field.remote_port")}
						control={<Input target={fields} prop="remotePort" placeholder={"5000"} required={true} />}
					/>
				</FieldGroup>
				<FieldGroup legend={t("dev.quality_scoring")}>
					<Field
						label={t("dev.scheduler")}
						control={
							<select
								disabled={busy.has("srtla-mode")}
								value={modeValue(host)}
								onchange={(e: Event) => void setOption(host, "mode", (e.target as HTMLSelectElement).value)}
							>
								<SchedulerOptions />
							</select>
						}
					/>
					<CheckField
						label={t("dev.quality_scoring")}
						title={t("dev.quality_scoring_title")}
						control={
							<input
								type={"checkbox"}
								checked={qualityValue(host)}
								disabled={busy.has("srtla-quality") || modeValue(host) === "classic"}
								onchange={(e: Event) =>
									void setOption(host, "quality", (e.target as HTMLInputElement).checked)
								}
							/>
						}
					/>
				</FieldGroup>
				<Break />
				{combined
					? streamButtons(host, "stream.stop")
					: (
						<Actions>
							<Button label={t("ui.start")} type={"submit"} disabled={!host.enabled("srtla-start")} />
							<Button
								label={t("ui.stop")}
								class={"danger"}
								disabled={!host.enabled("srtla-stop")}
								onclick={() => host.press("srtla-stop", "srtla.stop")}
							/>
							<Button
								label={t("ui.reload")}
								disabled={!host.enabled("srtla-reload")}
								onclick={() => host.press("srtla-reload", "srtla.reload")}
							/>
						</Actions>
					)}
			</Form>
		</Card>
	);
}

// ----------------------------------------------------------------- stats widget

/** The widget's own device's live srtla stats (the core hands the device's
 * `DeviceLive` bag in `ctx`; the module knows its own key). */
const srtlaStatsOf = (ctx: WidgetContext): SrtlaStats | undefined =>
	(ctx.deviceLive as { srtla?: SrtlaStats } | undefined)?.srtla;

/** One row per SRT link: label/ip plus connection badge and rate. */
function srtlaLinksRows(s: SrtlaStats): [string, Child][] {
	return (s.links ?? []).map((l) => [
		l.label ?? l.ip,
		<span>
			{l.connected ? <Badge text={t("dev.badge.online")} kind={"on"} /> : <Badge text={t("dev.badge.offline")} kind={"off"} />}{" "}
			<span class={"muted"}>{`${formatBitrate(l.bitrate_bytes_per_sec)} · ${l.rtt_ms} ms`}</span>
		</span>,
	]);
}

/** The stats table (or a no-links placeholder when the stream has no links). */
function srtlaTable(s: SrtlaStats): m.Vnode {
	const rows = srtlaLinksRows(s);
	return rows.length ? (
		<table class={"dash-table"}>
			<tbody>
				{rows.map(([label, value], i) => (
					<tr key={i}>
						<th>{label}</th>
						<td>{value}</td>
					</tr>
				))}
			</tbody>
		</table>
	) : (
		<p class={"muted"}>{t("dev.badge.no_links")}</p>
	);
}

/** The `stats` dashboard widget: the SRTLA link table for its device. */
function statsBody(w: ServerDashboardWidget, ctx: WidgetContext): m.Children {
	const s = srtlaStatsOf(ctx);
	if (!s)
		return <p class={"muted"}>{ctx.deviceLive ? t("dash.widget_waiting") : t("dev.badge.offline")}</p>;
	return srtlaTable(s);
}

function statsBadge(w: ServerDashboardWidget, ctx: WidgetContext): m.Vnode {
	const s = srtlaStatsOf(ctx);
	if (!s)
		return <Badge text={ctx.deviceLive ? t("dash.widget_waiting") : t("dev.badge.offline")} kind={ctx.deviceLive ? "" : "off"} />;
	return <Badge text={`${s.active_links ?? 0}/${s.total_links ?? 0}`} kind={"on"} />;
}

const srtlaStatsWidget: ChannelWidgetModule<ServerDashboardWidget> = {
	id: "srtla-stats",
	kind: "widget",
	widgetTypes: ["stats"],
	defaultSize: { w: 3, h: 2 },
	configFields: [] as const,
	channelOf: () => "",
	body: statsBody,
	badge: statsBadge,
};

const srtlaModule: BridgedModule = {
	id: "srtla",
	kind: "device-card",
	title: "SRTLA",
	defaultSize: { w: 4, h: 4 },
	minSize: { w: 3, h: 3 },
	component: (status: Status) => srtlaCardBody(card, status),
	cardBody: (host, status) => srtlaCardBody(host as DeviceCard, status as Status),
};

export default [srtlaModule, srtlaStatsWidget];
