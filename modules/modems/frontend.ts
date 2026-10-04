/* Modems card: one panel per ModemManager modem with its signal and power controls. */
import m from "mithril";
import type { Status } from "../../public/types";
import { actions, badge, button, Card, definitionList } from "../../public/ts/components/ui";
import { t } from "../../public/ts/i18n";
import { signal } from "../../public/ts/device/interfaces";
import { act, busy, st } from "../../public/ts/device/store";
import type { ModemInfo } from "./backend";
import type { BrowserModule } from "../types";

function modemAction(method: string, index: number): void {
	if (method === "modems.reset" && !confirm(t("dev.reset_confirm", index))) return;
	void act(`modem:${method}:${index}`, method, { index });
}

const stateKind = (state: string) =>
	state === "connected" ? "on" : state === "disabled" || state === "failed" ? "off" : "warn";

function modemPanel(modem: ModemInfo): m.Vnode {
	const control = (label: string, method: string, cls = "secondary") =>
		button(label, {
			class: cls,
			disabled: busy.has(`modem:${method}:${modem.index}`) || !!st.status?.state.srtla,
			onclick: () => modemAction(method, modem.index),
		});
	const connected = modem.state === "connected";
	const name = [modem.manufacturer, modem.model].filter(Boolean).join(" ") || t("dev.modem_fallback");
	return m(
		"article.modem",
		{ key: modem.index },
		m("h3", m("span", `#${modem.index} ${name}`), badge(modem.state, stateKind(modem.state))),
		definitionList([
			[t("dev.signal"), signal(modem.signalQuality)],
			[t("dev.operator"), modem.operatorName],
			[t("dev.tech"), modem.accessTech],
			[t("dev.registration"), modem.registrationState],
			[t("dev.power"), modem.powerState],
			[t("dev.imei"), modem.imei],
		]),
		actions(
			control(t("ui.enable"), "modems.enable"),
			control(t("ui.disable"), "modems.disable"),
			connected
				? control(t("ui.disconnect"), "modems.disconnect")
				: control(t("ui.connect"), "modems.connect"),
			control(t("ui.reset"), "modems.reset", "danger"),
		),
	);
}

export const modemsModule: BrowserModule = {
	id: "modems",
	title: "Modems",
	defaultWidth: "full",
	component: (status: Status) =>
		m(
			Card,
			{ title: t("dev.card.modems"), class: "mod-modems" },
			status.modems.length ? m("div.grid", status.modems.map(modemPanel)) : m("p.muted", t("dev.no_modems")),
		),
};
