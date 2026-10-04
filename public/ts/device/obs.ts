/* OBS Studio module UI. `obs.request` / `obs.requestBatch` pass obs-websocket v5 payloads through
 * device verbatim (`d` fields); the browser is never a direct OBS client. Live state (scene,
 * streaming, recording) arrives via `obs.event` pushes, routed in store.ts. */
import m from "mithril";
import { badge, Card, definitionList } from "../components/ui";
import { t } from "../i18n";
import { act, st } from "./store";

interface ObsRequestResponse<T> {
	requestType: string;
	requestId: string;
	requestStatus: { result: boolean; code: number; comment?: string };
	responseData?: T;
}

export function obsRequest<T = Record<string, unknown>>(
	requestType: string,
	requestData: Record<string, unknown> = {},
): Promise<ObsRequestResponse<T> | undefined> {
	return act(
		null,
		"obs.request",
		{ requestType, requestId: crypto.randomUUID(), requestData },
	) as Promise<ObsRequestResponse<T> | undefined>;
}

export function obsBatch(
	requests: Array<{ requestType: string; requestData?: Record<string, unknown> }>,
	opts?: { haltOnFailure?: boolean; executionType?: 0 | 1 | 2 },
): Promise<{ requestId: string; results: ObsRequestResponse<Record<string, unknown>>[] } | undefined> {
	return act(null, "obs.requestBatch", {
		requestId: crypto.randomUUID(),
		requests: requests.map((r) => ({ ...r, requestId: crypto.randomUUID() })),
		haltOnFailure: opts?.haltOnFailure ?? false,
		executionType: opts?.executionType ?? 0,
	});
}

export function obsCard(): m.Vnode {
	const enabled = st.modules["obs-controller"]?.enabled;
	const obs = st.obs;
	return m(
		Card,
		{ title: t("obs.card") },
		!enabled ? m("p.muted", t("obs.disabled")) : null,
		m("div.badge-row", badge(obs.connected ? t("obs.connected") : t("obs.offline"), obs.connected ? "on" : "off")),
		definitionList([
			[t("obs.scene"), m("code", obs.scene ?? "—")],
			[t("obs.streaming"), badge(obs.streaming ? t("ui.on") : t("ui.off"), obs.streaming ? "on" : "off")],
			[t("obs.recording"), badge(obs.recording ? t("ui.on") : t("ui.off"), obs.recording ? "on" : "off")],
		]),
	);
}
