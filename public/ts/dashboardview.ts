/* Dashboard view page: read-only live rendering of a dashboard defined on the
 * server control. */
import m from "mithril";
import type { ServerDashboard } from "../types";
import { badge, Card, Page, serverNav } from "./components/ui";
import { devices, refreshDevices, syncConnectionsFor, widgetView } from "./dashboard";
import { t } from "./i18n";
import { mountPage } from "./util";

const REFRESH_MS = 3_000;

const id = location.pathname.match(/\/dashboards\/(?:edit|view)\/([^/]+)\/?$/)?.[1] ?? "";

const state = {
	dash: undefined as ServerDashboard | undefined,
	notFound: false,
	onlineText: t("mgmt.loading"),
};

async function refresh(): Promise<void> {
	await refreshDevices();
	const list = devices.list ?? [];
	state.onlineText = `${list.filter((d) => d.online).length}/${list.length}`;
}

const App: m.Component = {
	view() {
		return m(
			Page,
			{
				title: t("dash.title"),
				nav: serverNav("dashboards"),
				headerRight: [
					m("span.muted", [t("dash.devices"), " ", state.onlineText]),
					m("a.dash-row-link", { href: `/dashboards/` }, t("dash.back")),
					state.dash
						? m("a.dash-row-link", { href: `/dashboards/edit/${encodeURIComponent(state.dash.id)}/` }, t("dash.edit"))
						: null,
				],
			},
			state.notFound
				? m(Card, { title: t("dash.title") }, badge(t("dash.not_found"), "warn"))
				: !state.dash
					? m(Card, { title: t("dash.title") }, m("p.muted", t("mgmt.loading")))
					: m(
							Card,
							{
								title: state.dash.name,
								headActions: m("a.dash-row-link", { href: `/dashboards/edit/${encodeURIComponent(state.dash.id)}/` }, t("dash.edit")),
							},
							state.dash.widgets.length
								? m("div.dashboard-grid", state.dash.widgets.map(widgetView))
								: m("p.muted", t("dash.no_widgets")),
						),
		);
	},
};

void (async () => {
	const res = await fetch(`/api/dashboards/${encodeURIComponent(id)}`, { cache: "no-store" }).catch(() => null);
	const body = (res?.ok ? await res.json().catch(() => null) : null) as { ok?: boolean; dashboard?: ServerDashboard } | null;
	if (body?.ok && body.dashboard) {
		state.dash = body.dashboard;
	} else {
		state.notFound = true;
	}
	await refresh();
	syncConnectionsFor(state.dash);
	m.redraw();
	setInterval(() => {
		void refresh();
		syncConnectionsFor(state.dash);
		m.redraw();
	}, REFRESH_MS);
})();

mountPage(t("dash.title"), App);
