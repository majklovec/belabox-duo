/* OBS Studio card: live scene/streaming/recording state pushed via `obs.event`
 * (`obs.request` / `obs.requestBatch` pass obs-websocket v5 payloads through the
 * device verbatim — the browser is never a direct OBS client). The card is not
 * rendered by the device page for now (no UI change in this migration). */
import m from "mithril";
import { badge, Card, definitionList } from "../../public/ts/components/ui";
import { t } from "../../public/ts/i18n";
import { st } from "../../public/ts/device/store";
import type { BrowserModule } from "../types";

function obsControllerCard(): m.Vnode {
	const enabled = st.modules["obs-controller"]?.enabled;
	const obs = st.obs;
	return m(
		Card,
		{ title: t("obs.card"), class: "mod-obs-controller" },
		!enabled ? m("p.muted", t("obs.disabled")) : null,
		m("div.badge-row", badge(obs.connected ? t("obs.connected") : t("obs.offline"), obs.connected ? "on" : "off")),
		definitionList([
			[t("obs.scene"), m("code", obs.scene ?? "—")],
			[t("obs.streaming"), badge(obs.streaming ? t("ui.on") : t("ui.off"), obs.streaming ? "on" : "off")],
			[t("obs.recording"), badge(obs.recording ? t("ui.on") : t("ui.off"), obs.recording ? "on" : "off")],
		]),
	);
}

function handleEvent(event: string, data: unknown): void {
	if (event !== "obs.event") return;
	const ev = data as { eventType?: string; eventData?: Record<string, unknown> };
	const d = (ev.eventData ?? {}) as Record<string, unknown>;
	switch (ev.eventType) {
		case "CurrentProgramSceneChanged":
			st.obs.scene = (d.sceneName as string) ?? null;
			st.obs.connected = true;
			break;
		case "StreamStateChanged":
			st.obs.streaming = d.outputActive === true;
			st.obs.connected = true;
			break;
		case "RecordStateChanged":
			st.obs.recording = d.outputActive === true;
			st.obs.connected = true;
			break;
		case "ObsDisconnected":
			st.obs.connected = false;
			st.obs.scene = null;
			break;
	}
	m.redraw();
}

export const obsControllerModule: BrowserModule = {
	id: "obs-controller",
	title: "OBS",
	defaultWidth: "third",
	component: () => obsControllerCard(),
	handleEvent,
};
