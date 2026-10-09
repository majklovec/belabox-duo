/* Dashboards list page: create, view, edit, delete dashboards. The list stays
 * in sync over the shared feed websocket (dashboards.snapshot /
 * dashboards.changed); the initial fetch only loads the page before the socket
 * opens. */
import m from "mithril";
import type { ServerDashboard } from "../types";
import { button, Card, Page, input, serverNav } from "./components/ui";
import { t } from "./i18n";
import { actionIcon } from "./icons";
import { serverLive } from "./services/serverws";
import { mountPage } from "./util";

const state = {
	dashboards: [] as ServerDashboard[],
	newName: "",
	saving: false,
};

serverLive.on({
	dashboards: (list) => {
		state.dashboards = list;
		m.redraw();
	},
});

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
	return (
		<table class={"dash-table"}>
			<thead>
				<tr>
					<th>{t("dash.name")}</th>
					<th>{t("dash.widgets")}</th>
					<th />
				</tr>
			</thead>
			<tbody>
				{state.dashboards.map((d) => (
					<tr key={d.id}>
						<td class={"dash-name"}>
							<a class={"dash-row-link"} href={`/dashboards/view/${encodeURIComponent(d.id)}/`}>
								{d.name}
							</a>
						</td>
						<td
							class={"muted"}
						>{`${d.widgets.length} ${d.widgets.length === 1 ? t("dash.widget") : t("dash.widgets").toLowerCase()}`}</td>
						<td class={"actions-cell"}>
							<div class={"dash-row-actions"}>
								{[
									<a
										class={"icon-link"}
										href={`/dashboards/view/${encodeURIComponent(d.id)}/`}
										title={t("dash.view")}
										aria-label={t("dash.view")}
									>
										{actionIcon("view")}
									</a>,
									<a
										class={"icon-link"}
										href={`/dashboards/edit/${encodeURIComponent(d.id)}/`}
										title={t("dash.edit")}
										aria-label={t("dash.edit")}
									>
										{actionIcon("edit")}
									</a>,
									button(actionIcon("delete"), {
										class: "icon-link dash-delete",
										title: t("dash.delete"),
										"aria-label": t("dash.delete"),
										onclick: () => deleteDashboard(d.id),
									}),
								]}
							</div>
						</td>
					</tr>
				))}
			</tbody>
		</table>
	);
}

function createToolbar(): m.Vnode {
	return (
		<div class={"dash-toolbar"}>
			<span class={"dash-empty-text"}>{t("dash.create_new")}</span>
			{input(state, "newName", { placeholder: t("dash.new_placeholder") }) as m.Vnode}
			{button(t("dash.create"), { onclick: createDashboard, disabled: state.saving || !state.newName.trim() })}
		</div>
	);
}

function dashboardsCard(): m.Vnode {
	return (
		<Card>
			{state.dashboards.length ? (
				[list(), createToolbar()]
			) : (
				<div class={"dash-empty"}>
					<p class={"muted"}>{t("dash.empty")}</p>
					{createToolbar()}
				</div>
			)}
		</Card>
	);
}

const App: m.Component = {
	view: () => (
		<Page title={t("dash.title")} nav={serverNav("dashboards")}>
			{dashboardsCard()}
		</Page>
	),
};

void refresh();
void mountPage(() => t("dash.title"), App);
