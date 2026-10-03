/* SRTLA card: srtla_send state, the receiver form and the scheduler options. */
import m from "mithril";
import type { Status } from "../../types";
import {
	actions,
	badge,
	brk,
	button,
	Card,
	type Child,
	checkField,
	definitionList,
	field,
	fieldGroup,
	form,
	input,
	schedulerOptions,
} from "../components/ui";
import { since } from "../util";
import { t } from "../i18n";
import { act, busy, enabled, fields, press, st } from "./store";
import { encoderStart, streamButtons } from "./encoder";

type SrtlaOptions = Status["state"]["srtlaOptions"];

function srtlaStart(): void {
	if (!fields.listenPort || !fields.remoteHost || !fields.remotePort) return;
	press("srtla-start", "srtla.start", {
		listenPort: fields.listenPort,
		remoteHost: fields.remoteHost,
		remotePort: fields.remotePort,
	});
}

async function setOption(key: keyof SrtlaOptions, value: string | boolean): Promise<void> {
	const result = await act<{ options: SrtlaOptions }>(`srtla-${key}`, "srtla.options", { [key]: value });
	// The status push is debounced; do not flash the old value until it arrives
	if (result && st.status) st.status.state.srtlaOptions = result.options;
}

// Scheduler options: the saved settings, else what the running srtla_send reports, else its defaults
function liveStats() {
	return st.status?.state.srtla.running ? st.stats : null;
}
const modeValue = (): string => st.status?.state.srtlaOptions?.mode ?? liveStats()?.mode ?? "enhanced";
const qualityValue = (): boolean => st.status?.state.srtlaOptions?.quality ?? liveStats()?.quality_enabled ?? true;

function controlBadge(status: Status): Child {
	const c = status.srtlaControl;
	if (c?.connected) return badge(t("dev.connected"), "on");
	if (c?.supported) return badge(t("dev.control_connecting"), "warn");
	return m("span.muted", { title: t("dev.control_unavailable_title") }, t("dev.control_unavailable"));
}

export function srtlaCard(status: Status): m.Vnode {
	const s = status.state.srtla;
	const combined = status.role === "combined";
	return m(
		Card,
		{ title: t("dev.card.srtla") },
		definitionList([
			[
				t("dev.row.state"),
				s.running ? badge(t("dev.row_state_running"), "on") : badge(t("dev.badge.stopped"), "off"),
			],
			[t("dev.row.started"), s.running ? since(s.startedAt) : null],
			[
				t("dev.reloads"),
				t("dev.reloads_detail", s.reloadCount ?? 0, since(s.lastReloadAt), status.monitor.reloadMode),
			],
			[
				t("dev.monitor"),
				status.monitor.running ? badge(t("dev.monitor_watching"), "on") : badge(t("ui.off"), "warn"),
			],
			[t("dev.control"), s.running ? controlBadge(status) : null],
		]),
		form(
			// Enter in the receiver fields of a combined device means "start the stream"
			{ onSubmit: combined ? encoderStart : srtlaStart },
			fieldGroup(
				t("dev.group.connection"),
				!combined && [
					field(
						t("dev.field.srt_listen_port"),
						input(fields, "listenPort", { placeholder: "6000", required: true }),
					),
					" ⇨ ",
				],
				field(
					t("dev.field.remote_host"),
					input(fields, "remoteHost", { placeholder: "rec.example.com", required: true }),
				),
				field(t("dev.field.remote_port"), input(fields, "remotePort", { placeholder: "5000", required: true })),
			),
			fieldGroup(
				t("dev.quality_scoring"),
				field(
					t("dev.scheduler"),
					m(
						"select",
						{
							disabled: busy.has("srtla-mode"),
							value: modeValue(),
							onchange: (e: Event) => void setOption("mode", (e.target as HTMLSelectElement).value),
						},
						schedulerOptions(),
					),
				),
				checkField(
					t("dev.quality_scoring"),
					m("input", {
						type: "checkbox",
						checked: qualityValue(),
						disabled: busy.has("srtla-quality") || modeValue() === "classic",
						onchange: (e: Event) => void setOption("quality", (e.target as HTMLInputElement).checked),
					}),
					{ title: t("dev.quality_scoring_title") },
				),
			),
			brk(),
			combined
				? streamButtons("stream.stop")
				: actions(
						button(t("ui.start"), { type: "submit", disabled: !enabled("srtla-start") }),
						button(t("ui.stop"), {
							class: "danger",
							disabled: !enabled("srtla-stop"),
							onclick: () => press("srtla-stop", "srtla.stop"),
						}),
						button(t("ui.reload"), {
							disabled: !enabled("srtla-reload"),
							onclick: () => press("srtla-reload", "srtla.reload"),
						}),
					),
		),
	);
}
