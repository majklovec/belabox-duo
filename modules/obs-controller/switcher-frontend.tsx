/* Low-bitrate switcher card: live state-machine status (pushed as
 * lowBitrateSwitcher.state) and the module settings form (modules.configure). */
import m from "mithril";

import type { Status } from "../../public/types";
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
	form as formBox,
	input,
	numberAttrs,
	options,
} from "../../public/ts/components/ui";
import { since } from "../../public/ts/util";
import { t } from "../../public/ts/i18n";
import { card, type DeviceCard } from "../../public/ts/device/store";
import type { SwitcherStatus } from "./types";

/** Module ids a source can read from (the relay slot accepts the "srtla" id too). */
const SOURCE_MODULES: [string, string][] = [
	["encoder", "encoder"],
	["modems", "modems"],
	["srtla", "srtla (relay)"],
];
const COMBINED_MODULES: [string, string][] = [...SOURCE_MODULES, ["obs-controller", "obs-controller"]];

/** Flat form over the persisted config; strings for the numeric inputs. */
interface SwitcherForm {
	autoSwitch: boolean;
	encEnabled: boolean;
	encModule: string;
	relEnabled: boolean;
	relModule: string;
	combEnabled: boolean;
	combModule: string;
	lowBitrate: string;
	offlineBitrate: string;
	rtt: string;
	retryAttempts: string;
	pollInterval: string;
	instantlyRecover: boolean;
	onlySwitchWhenStreaming: boolean;
	sceneNormal: string;
	sceneLow: string;
	sceneOffline: string;
	sceneStarting: string;
	sceneEnding: string;
	scenePrivacy: string;
	logToFile: boolean;
}

let form: SwitcherForm | undefined;
let live: SwitcherStatus | null = null;

function loadForm(status: Status): SwitcherForm {
	const c = status.modules["obs-controller"].switcher;
	return {
		autoSwitch: c.switcher.bitrateSwitcherEnabled,
		encEnabled: c.sources.encoder.enabled,
		encModule: c.sources.encoder.moduleId,
		relEnabled: c.sources.relay.enabled,
		relModule: c.sources.relay.moduleId === "relay" ? "srtla" : c.sources.relay.moduleId,
		combEnabled: c.sources.combined.enabled,
		combModule: c.sources.combined.moduleId,
		lowBitrate: String(c.switcher.triggers.low),
		offlineBitrate: String(c.switcher.triggers.offline),
		rtt: String(c.switcher.triggers.rtt),
		retryAttempts: String(c.switcher.retryAttempts),
		pollInterval: String(c.switcher.pollIntervalMs),
		instantlyRecover: c.switcher.instantlySwitchOnRecover,
		onlySwitchWhenStreaming: c.switcher.onlySwitchWhenStreaming,
		sceneNormal: c.switcher.switchingScenes.normal,
		sceneLow: c.switcher.switchingScenes.low,
		sceneOffline: c.switcher.switchingScenes.offline,
		sceneStarting: c.optionalScenes.starting,
		sceneEnding: c.optionalScenes.ending,
		scenePrivacy: c.optionalScenes.privacy,
		logToFile: c.logToFile,
	};
}

function toConfig(status: Status): Record<string, unknown> {
	const f = form!;
	const num = (s: string): number => {
		const v = Number(s);
		return Number.isFinite(v) && v >= 0 ? v : 0;
	};
	const saved = status.modules["obs-controller"].switcher;
	return {
		sources: {
			encoder: { enabled: f.encEnabled, moduleId: f.encModule },
			relay: { enabled: f.relEnabled, moduleId: f.relModule === "srtla" ? "relay" : f.relModule },
			combined: {
				enabled: f.combEnabled,
				moduleId: f.combModule,
				fieldMap: saved?.sources.combined.fieldMap ?? {
					bitrate: "bitrate",
					rtt: "rtt",
					connected: "connected",
					streaming: "streaming",
				},
			},
		},
		switcher: {
			bitrateSwitcherEnabled: f.autoSwitch,
			onlySwitchWhenStreaming: f.onlySwitchWhenStreaming,
			instantlySwitchOnRecover: f.instantlyRecover,
			retryAttempts: Math.max(1, Math.min(100, Math.floor(Number(f.retryAttempts) || 1))),
			pollIntervalMs: Math.max(200, Math.floor(Number(f.pollInterval) || 1000)),
			triggers: { low: num(f.lowBitrate), offline: num(f.offlineBitrate), rtt: num(f.rtt) },
			switchingScenes: { normal: f.sceneNormal, low: f.sceneLow, offline: f.sceneOffline },
		},
		optionalScenes: { starting: f.sceneStarting, ending: f.sceneEnding, privacy: f.scenePrivacy },
		logToFile: f.logToFile,
	};
}

function save(host: DeviceCard, status: Status): void {
	void host.act("switcher-save", "modules.configure", {
		id: "obs-controller",
		config: { switcher: toConfig(status) },
	});
}

const stateBadge = (state: SwitcherStatus["state"]): Child =>
	state === "NORMAL"
		? badge(t("lowbs.state_normal"), "on")
		: state === "LOW"
			? badge(t("lowbs.state_low"), "warn")
			: badge(t("lowbs.state_offline"), "off");

function switcherCardBody(host: DeviceCard, status: Status): m.Vnode {
	if (form === undefined) form = loadForm(status);
	const f = form;
	const s = live ?? status.lowBitrateSwitcher ?? null;
	const busy = host.busy.has("switcher-save");
	return (
		<Card title={t("lowbs.title")} class={"mod-switcher"}>
			{definitionList([
				[t("lowbs.row_state"), s ? stateBadge(s.state) : badge(t("lowbs.idle"), "off")],
				[
					t("lowbs.row_desired"),
					s ? (
						<span>
							{[
								stateBadge(s.desiredState),
								s.desiredState !== s.state && (
									<span
										class={"muted"}
									>{` · ${t("lowbs.row_retries", s.retryCount, f.retryAttempts)}`}</span>
								),
							]}
						</span>
					) : null,
				],
				[t("lowbs.row_scene"), s?.currentScene ?? null],
				[t("lowbs.row_updated"), s ? since(s.updatedAt) : null],
			])}
			{formBox(
				{ onSubmit: () => save(host, status) },
				checkField(
					t("lowbs.auto_switch"),
					<input
						type={"checkbox"}
						checked={f.autoSwitch}
						onchange={(e: Event) => (f.autoSwitch = (e.target as HTMLInputElement).checked)}
					/>,
				),
				fieldGroup(
					t("lowbs.group_sources"),
					checkField(
						t("lowbs.source_encoder"),
						<input
							type={"checkbox"}
							checked={f.encEnabled}
							onchange={(e: Event) => (f.encEnabled = (e.target as HTMLInputElement).checked)}
						/>,
					),
					<select
						value={f.encModule}
						disabled={!f.encEnabled}
						class={"lbs-select"}
						onchange={(e: Event) => (f.encModule = (e.target as HTMLSelectElement).value)}
					>
						{options(SOURCE_MODULES)}
					</select>,
					brk(),
					checkField(
						t("lowbs.source_relay"),
						<input
							type={"checkbox"}
							checked={f.relEnabled}
							onchange={(e: Event) => (f.relEnabled = (e.target as HTMLInputElement).checked)}
						/>,
					),
					<select
						value={f.relModule}
						disabled={!f.relEnabled}
						class={"lbs-select"}
						onchange={(e: Event) => (f.relModule = (e.target as HTMLSelectElement).value)}
					>
						{options(SOURCE_MODULES)}
					</select>,
					brk(),
					checkField(
						t("lowbs.source_combined"),
						<input
							type={"checkbox"}
							checked={f.combEnabled}
							onchange={(e: Event) => (f.combEnabled = (e.target as HTMLInputElement).checked)}
						/>,
					),
					<select
						value={f.combModule}
						title={t("lowbs.group_sources_title")}
						disabled={!f.combEnabled}
						class={"lbs-select"}
						onchange={(e: Event) => (f.combModule = (e.target as HTMLSelectElement).value)}
					>
						{options(COMBINED_MODULES)}
					</select>,
				),
				fieldGroup(
					t("lowbs.group_triggers"),
					<div class={"lbs-grid"}>
						{[
							field(
								t("lowbs.trigger_low_bitrate"),
								input(
									{ v: f.lowBitrate } as { v: string },
									"v",
									numberAttrs(0, 1e9, "2500"),
									(v) => (f.lowBitrate = v),
								),
							),
							field(
								t("lowbs.trigger_offline_bitrate"),
								input(
									{ v: f.offlineBitrate } as { v: string },
									"v",
									numberAttrs(0, 1e9, "500"),
									(v) => (f.offlineBitrate = v),
								),
							),
							field(
								t("lowbs.trigger_rtt"),
								input(
									{ v: f.rtt } as { v: string },
									"v",
									numberAttrs(0, 1e6, "300"),
									(v) => (f.rtt = v),
								),
							),
							field(
								t("lowbs.retry_attempts"),
								input(
									{ v: f.retryAttempts } as { v: string },
									"v",
									numberAttrs(1, 100, "3"),
									(v) => (f.retryAttempts = v),
								),
							),
							field(
								t("lowbs.poll_interval"),
								input(
									{ v: f.pollInterval } as { v: string },
									"v",
									numberAttrs(200, 3600000, "1000"),
									(v) => (f.pollInterval = v),
								),
							),
						]}
					</div>,
				),
				fieldGroup(
					t("lowbs.group_scenes"),
					<div class={"lbs-grid"}>
						{[
							field(t("lowbs.scene_normal"), input(f, "sceneNormal", { placeholder: "Normal" })),
							field(t("lowbs.scene_low"), input(f, "sceneLow", { placeholder: "Low" })),
							field(t("lowbs.scene_offline"), input(f, "sceneOffline", { placeholder: "Offline" })),
							field(t("lowbs.scene_starting"), input(f, "sceneStarting", { placeholder: "—" })),
							field(t("lowbs.scene_ending"), input(f, "sceneEnding", { placeholder: "—" })),
							field(t("lowbs.scene_privacy"), input(f, "scenePrivacy", { placeholder: "—" })),
						]}
					</div>,
				),
				brk(),
				checkField(
					t("lowbs.instantly_recover"),
					<input
						type={"checkbox"}
						checked={f.instantlyRecover}
						onchange={(e: Event) => (f.instantlyRecover = (e.target as HTMLInputElement).checked)}
					/>,
				),
				checkField(
					t("lowbs.only_streaming"),
					<input
						type={"checkbox"}
						checked={f.onlySwitchWhenStreaming}
						onchange={(e: Event) => (f.onlySwitchWhenStreaming = (e.target as HTMLInputElement).checked)}
					/>,
				),
				checkField(
					t("lowbs.log_to_file"),
					<input
						type={"checkbox"}
						checked={f.logToFile}
						onchange={(e: Event) => (f.logToFile = (e.target as HTMLInputElement).checked)}
					/>,
				),
				brk(),
				actions(button(t("ui.save"), { type: "submit", disabled: busy })),
			)}
		</Card>
	);
}

/**
 * The switcher card, rendered by the obs module below its own card. Returns
 * null when the switcher is not enabled (its toggle then lives in the obs
 * card's head only).
 */
export function switcherCard(status: Status): m.Vnode | null {
	if (status.modules["obs-controller"].switcherEnabled !== true) return null;
	return switcherCardBody(card, status);
}

/** Routes the pushed switcher live state (invoked by the obs module). */
export function handleSwitcherEvent(event: string, data: unknown): void {
	if (event === "lowBitrateSwitcher.state") {
		live = (data as SwitcherStatus) ?? null;
		m.redraw();
	}
}
