/* Dashboards list page: create, view, edit, delete dashboards. */
import m from "mithril";
import type { ServerDashboard } from "../types";
import { button, Card, Page, input, serverNav } from "./components/ui";
import { t } from "./i18n";
import { actionIcon } from "./icons";
import { mountPage } from "./util";

const REFRESH_MS = 3_000;

const state = {
	dashboards: [] as ServerDashboard[],
	newName: "",
	saving: false,
};

async function refresh(): Promise<void> {
	const res = await fetch("/api/dashboards", { cache: "no-store" }).catch(() => null);
	if (res?.ok) {
		state.dashboards = ((await res.json()) as { dashboards: ServerDashboard[] }).dashboards;
		m.redraw();
	}
}

function createDashboard(): void {
	const name = state.newName.trim();
	if (!name) return;
	state.saving = true;
	m.redraw();
	void fetch("/api/dashboards", {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify({ name, widgets: [] }),
	})
		.then(async (res) => {
			if (!res.ok) throw new Error((await res.json().catch(() => null))?.error ?? `HTTP ${res.status}`);
			const body = (await res.json()) as { dashboard: ServerDashboard; dashboards: ServerDashboard[] };
			state.dashboards = body.dashboards;
			state.newName = "";
		})
		.catch((err) => console.error("dashboard create:", err))
		.finally(() => {
			state.saving = false;
			m.redraw();
		});
}

function deleteDashboard(id: string): void {
	void fetch(`/api/dashboards/${encodeURIComponent(id)}`, { method: "DELETE" })
		.then(async (res) => {
			if (!res.ok) throw new Error(`HTTP ${res.status}`);
			state.dashboards = (await res.json()).dashboards;
		})
		.catch((err) => console.error("dashboard delete:", err))
		.finally(m.redraw);
}

function list(): m.Vnode {
	return m(
		"table.dash-table",
		m("thead", m("tr", m("th", t("dash.name")), m("th", t("dash.widgets")), m("th"))),
		m(
			"tbody",
			state.dashboards.map((d) =>
				m(
					"tr",
					{ key: d.id },
					m("td.dash-name", m("a.dash-row-link", { href: `/dashboards/view/${encodeURIComponent(d.id)}/` }, d.name)),
					m("td.muted", `${d.widgets.length} ${d.widgets.length === 1 ? t("dash.widget") : t("dash.widgets").toLowerCase()}`),
					m(
						"td.actions-cell",
						m("div.dash-row-actions", [
							m("a.icon-link", { href: `/dashboards/view/${encodeURIComponent(d.id)}/`, title: t("dash.view"), "aria-label": t("dash.view") }, actionIcon("view")),
							m("a.icon-link", { href: `/dashboards/edit/${encodeURIComponent(d.id)}/`, title: t("dash.edit"), "aria-label": t("dash.edit") }, actionIcon("edit")),
							button(actionIcon("delete"), { class: "icon-link dash-delete", title: t("dash.delete"), "aria-label": t("dash.delete"), onclick: () => deleteDashboard(d.id) }),
						]),
					),
				),
			),
		),
	);
}

function createToolbar(): m.Vnode {
	return m(
		"div.dash-toolbar",
		m("span.dash-empty-text", t("dash.create_new")),
		input(state, "newName", { placeholder: t("dash.new_placeholder") }) as m.Vnode,
		button(t("dash.create"), { onclick: createDashboard, disabled: state.saving || !state.newName.trim() }),
	);
}

function dashboardsCard(): m.Vnode {
	return m(
		Card,
		{  },
		state.dashboards.length ? [list(), createToolbar()] : m("div.dash-empty", m("p.muted", t("dash.empty")), createToolbar()),
	);
}

const App: m.Component = {
	view: () =>
		m(
			Page,
			{
				title: t("dash.title"),
				nav: serverNav("dashboards"),
			},
			dashboardsCard(),
		),
};

void refresh();
void mountPage(() => t("dash.title"), App);
setInterval(() => {
	void refresh();
}, REFRESH_MS);
