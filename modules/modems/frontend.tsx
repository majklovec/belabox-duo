/* Modems card: one panel per ModemManager modem with its signal and power controls. */
import m from "mithril";
import type { Status } from "../../public/types";
import { actions, badge, button, Card, definitionList } from "../../public/ts/components/ui";
import { t } from "../../public/ts/i18n";
import { signal } from "../../public/ts/device/interfaces";
import { act, busy, st } from "../../public/ts/device/store";
import type { ModemInfo } from "../../public/types";
import type { BridgedModule } from "./types";
import { css } from "styled-system/css";

function modemAction(method: string, index: number): void {
	if (method === "modems.reset" && !confirm(t("dev.reset_confirm", index))) return;
	void act(`modem:${method}:${index}`, method, { index });
}

const stateKind = (state: string) =>
	state === "connected" ? "on" : state === "disabled" || state === "failed" ? "off" : "warn";

function modemPanel(modem: ModemInfo): m.Vnode {
	const control = (label: string, method: string, tone: "secondary" | "danger" = "secondary") =>
		button(label, {
			size: "sm",
			tone,
			disabled: busy.has(`modem:${method}:${modem.index}`) || !!st.status?.state.srtla,
			onclick: () => modemAction(method, modem.index),
		});
	const connected = modem.state === "connected";
	const name = [modem.manufacturer, modem.model].filter(Boolean).join(" ") || t("dev.modem_fallback");
	return (
		<article key={modem.index} class={css({borderRadius: "0.5rem", borderWidth: "1px", borderColor: "white/10", backgroundColor: "neutral/5", padding: "0.75rem"})}>
			<h3 class={css({marginBottom: "0.5rem", display: "flex", alignItems: "center", gap: "0.5rem", fontSize: "0.875rem", lineHeight: "1.25rem", fontWeight: "600"})}>
				{`#${modem.index} ${name}`}
				{badge(modem.state, stateKind(modem.state))}
			</h3>
			{definitionList([
				[t("dev.signal"), signal(modem.signalQuality)],
				[t("dev.operator"), modem.operatorName],
				[t("dev.tech"), modem.accessTech],
				[t("dev.registration"), modem.registrationState],
				[t("dev.power"), modem.powerState],
				[t("dev.imei"), modem.imei],
			])}
			{actions(
				control(t("ui.enable"), "modems.enable"),
				control(t("ui.disable"), "modems.disable"),
				connected
					? control(t("ui.disconnect"), "modems.disconnect")
					: control(t("ui.connect"), "modems.connect"),
				control(t("ui.reset"), "modems.reset", "danger"),
			)}
		</article>
	);
}

const modemsModule: BridgedModule = {
	id: "modems",
	kind: "device-card",
	title: "Modems",
	defaultSize: { w: 4, h: 4 },
	minSize: { w: 3, h: 3 },
	component: (status: Status) => (
		<Card title={t("dev.card.modems")} class="mod-modems">
			{status.modems.length ? (
				<div class={css({display: "grid", gap: "1rem", "sm": {gridTemplateColumns: "repeat(2, minmax(0, 1fr))"}, "xl": {gridTemplateColumns: "repeat(3, minmax(0, 1fr))"}})}>{status.modems.map(modemPanel)}</div>
			) : (
				<p class={css({color: "neutral"})}>{t("dev.no_modems")}</p>
			)}
		</Card>
	),
};

export default modemsModule;
