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
import { css } from "styled-system/css";

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
		<table class={css({width: "100%", fontSize: "0.875rem", lineHeight: "1.25rem"})}>
			<thead>
				<tr>
					<th class={css({paddingInline: "0.75rem", paddingBlock: "0.5rem", textAlign: "left", fontWeight: "500"})}>{t("dash.name")}</th>
					<th class={css({paddingInline: "0.75rem", paddingBlock: "0.5rem", textAlign: "left", fontWeight: "500"})}>{t("dash.widgets")}</th>
					<th class={css({paddingInline: "0.75rem", paddingBlock: "0.5rem"})} />
				</tr>
			</thead>
			<tbody class={css({"& td": {paddingInline: "0.75rem", paddingBlock: "0.5rem"}})}>
				{state.dashboards.map((d) => (
					<tr key={d.id}>
						<td>
							<a class={css({"&:hover": {textDecorationLine: "underline"}})} href={`/dashboards/view/${encodeURIComponent(d.id)}/`}>{d.name}</a>
						</td>
						<td class={css({color: "neutral"})}>{`${d.widgets.length} ${d.widgets.length === 1 ? t("dash.widget") : t("dash.widgets").toLowerCase()}`}</td>
						<td>
							<div class={css({display: "flex", alignItems: "center", gap: "0.25rem"})}>
								<a class={css({display: "inline-flex", alignItems: "center", borderRadius: "0.375rem", padding: "0.25rem", "&:hover": {backgroundColor: "neutral/10"}})} href={`/dashboards/view/${encodeURIComponent(d.id)}/`} title={t("dash.view")} aria-label={t("dash.view")}>
									{actionIcon("view")}
								</a>
								<a class={css({display: "inline-flex", alignItems: "center", borderRadius: "0.375rem", padding: "0.25rem", "&:hover": {backgroundColor: "neutral/10"}})} href={`/dashboards/edit/${encodeURIComponent(d.id)}/`} title={t("dash.edit")} aria-label={t("dash.edit")}>
									{actionIcon("edit")}
								</a>
								<button
									class={css({display: "inline-flex", alignItems: "center", borderRadius: "0.375rem", padding: "0.25rem", color: "error", "&:hover": {backgroundColor: "neutral/10"}})}
									title={t("dash.delete")}
									aria-label={t("dash.delete")}
									onclick={() => deleteDashboard(d.id)}
								>
									{actionIcon("delete")}
								</button>
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
		<div class={css({display: "flex", flexWrap: "wrap", alignItems: "center", gap: "0.5rem"})}>
			<span class={css({marginRight: "auto", fontSize: "0.875rem", lineHeight: "1.25rem", color: "neutral"})}>{t("dash.create_new")}</span>
			{input(state, "newName", { placeholder: t("dash.new_placeholder") })}
			{button(t("dash.create"), { onclick: createDashboard, disabled: state.saving || !state.newName.trim() })}
		</div>
	);
}

function dashboardsCard(): m.Vnode {
	return (
		<Card>
			{state.dashboards.length ? [list(), createToolbar()] : [
				<p class={css({fontSize: "0.875rem", lineHeight: "1.25rem", color: "neutral"})}>{t("dash.empty")}</p>,
				createToolbar(),
			]}
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
