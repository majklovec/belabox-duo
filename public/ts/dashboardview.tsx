/* Dashboard page: the merged inline grid editor. Serves both
 * `/dashboards/view/<id>/` (starts read-only) and `/dashboards/edit/<id>/`
 * (starts in edit mode). One GridStack grid renders the live widgets; in edit
 * mode widgets can be dragged/resized, hidden, removed, renamed and
 * re-configured; new widgets are added on the dedicated page
 * `/dashboards/add/<id>/` (public/ts/dashboardadd.ts). Layout + name changes
 * autosave (debounced) with optimistic concurrency: a 409 reloads the server
 * copy and toasts the conflict. Broadcast `dashboards.changed` events rebase
 * the dashboard from the server. */
import m from "mithril";
import type { ServerDashboard, ServerDashboardWidget } from "../types";
import { button, Page, serverNav, TitleWithBack } from "./components/ui";
import {
	ensureDashboardsWs,
	refreshDevices,
	setDashboardChangedSink,
	setWidgetConfigSaver,
	syncConnectionsFor,
	type WidgetActions,
} from "./dashboard";
import { pum } from "./jsx";
import { GridDashboard } from "./dashboardgrid";
import { t } from "./i18n";
import { actionIcon } from "./icons";
import { mountPage } from "./util";
import { css } from "styled-system/css";

const GridDashboardView = pum(GridDashboard);

const SAVE_DEBOUNCE_MS = 500;
const PATH_RE = /\/dashboards\/(view|edit)\/([^/]+)\/?$/;

type SaveState = "idle" | "saving" | "saved" | "error";

const state = {
	dash: undefined as ServerDashboard | undefined,
	notFound: false,
	editMode: false,
	saveState: "idle" as SaveState,
	saving: false,
	dashMenu: false,
	toast: undefined as string | undefined,
};

let saveTimer: number | null = null;
let toastTimer: number | null = null;

// -------------------------------------------------------------------- helpers

function toastMsg(msg: string, sticky = false): void {
	state.toast = msg;
	m.redraw();
	if (toastTimer !== null) window.clearTimeout(toastTimer);
	if (!sticky) toastTimer = window.setTimeout(() => (state.toast = undefined), 4_000);
}

function colsOf(dash: ServerDashboard | undefined): number {
	return dash?.columns ?? 12;
}

async function toggleFullscreen(): Promise<void> {
	try {
		if (document.fullscreenElement) await document.exitFullscreen();
		else await document.documentElement.requestFullscreen();
	} catch (err) {
		toastMsg(t("dash.fullscreen_error", err instanceof Error ? err.message : String(err)));
	}
}


// ---------------------------------------------------------------------- save

function scheduleSave(): void {
	state.saveState = "saving";
	if (saveTimer !== null) window.clearTimeout(saveTimer);
	saveTimer = window.setTimeout(() => void doSave(), SAVE_DEBOUNCE_MS);
	m.redraw();
}

async function doSave(): Promise<void> {
	const dash = state.dash;
	if (!dash || state.saving) return;
	if (saveTimer !== null) {
		window.clearTimeout(saveTimer);
		saveTimer = null;
	}
	state.saving = true;
	state.saveState = "saving";
	m.redraw();
	try {
		const res = await fetch(`/api/dashboards/${encodeURIComponent(dash.id)}`, {
			method: "PUT",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ name: dash.name, widgets: dash.widgets, version: dash.version }),
		});
		if (res.status === 409) {
			const conflict = (await res.json().catch(() => null)) as { current?: ServerDashboard } | null;
			await resync(conflict?.current);
			toastMsg(t("dash.conflict"), true);
			return;
		}
		if (!res.ok) throw new Error(`HTTP ${res.status}`);
		const body = (await res.json().catch(() => null)) as { dashboard?: ServerDashboard } | null;
		const fresh = body?.dashboard;
		if (fresh) {
			// Adopt the bumped version so the next save targets the latest revision;
			// keep our local widget objects (live bodies reference them).
			dash.version = fresh.version;
			dash.name = fresh.name;
			dash.columns = fresh.columns;
		}
		state.saveState = "saved";
		if (toastTimer !== null) window.clearTimeout(toastTimer);
		toastTimer = window.setTimeout(() => (state.saveState = "idle"), 2_000);
	} catch (err) {
		state.saveState = "error";
		toastMsg(t("dash.save_error"));
	} finally {
		state.saving = false;
		m.redraw();
	}
}

/** Rebase the dashboard onto the server copy (a saved `prefer` or a fresh GET). */
async function resync(prefer?: ServerDashboard): Promise<void> {
	const id = state.dash?.id;
	if (!id) return;
	let fresh = prefer;
	if (!fresh) {
		const res = await fetch(`/api/dashboards/${encodeURIComponent(id)}`, { cache: "no-store" }).catch(() => null);
		fresh = (res?.ok ? ((await res.json().catch(() => null)) as { dashboard?: ServerDashboard }) : null)?.dashboard;
	}
	if (fresh) {
		state.dash = { ...state.dash!, widgets: fresh.widgets, version: fresh.version, name: fresh.name, columns: fresh.columns };
		syncConnectionsFor(state.dash);
	}
	state.saveState = "idle";
	m.redraw();
}

// -------------------------------------------------------------- widget edits

function onLayout(widgets: ServerDashboardWidget[]): void {
	if (!state.dash) return;
	state.dash = { ...state.dash!, widgets };
	scheduleSave();
}

function removeWidget(widget: ServerDashboardWidget): void {
	const dash = state.dash;
	if (!dash) return;
	state.dash = { ...dash, widgets: dash.widgets.filter((w) => w.id !== widget.id) };
	syncConnectionsFor(state.dash);
	scheduleSave();
}

function hideWidget(widget: ServerDashboardWidget): void {
	const dash = state.dash;
	if (!dash) return;
	state.dash = { ...dash, widgets: dash.widgets.map((w) => (w.id === widget.id ? { ...w, visible: !w.visible } : w)) };
	scheduleSave();
}

const actions: WidgetActions = { remove: removeWidget, hide: hideWidget };

// ------------------------------------------------------------- dashboard ops

function setEdit(on: boolean): void {
	state.editMode = on;
	m.redraw();
}

async function newDashboard(): Promise<void> {
	state.dashMenu = false;
	const res = await fetch("/api/dashboards", {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify({ name: t("dash.default_name") }),
	}).catch(() => null);
	const body = res?.ok ? ((await res.json().catch(() => null)) as { dashboard?: ServerDashboard }) : null;
	if (body?.dashboard) location.href = `/dashboards/edit/${encodeURIComponent(body.dashboard.id)}/`;
	else toastMsg(t("dash.save_error"));
}

function renameDashboard(): void {
	const dash = state.dash;
	if (!dash) return;
	state.dashMenu = false;
	const name = window.prompt(t("dash.rename"), dash.name);
	if (!name || !name.trim()) return;
	dash.name = name.trim();
	scheduleSave();
}

async function deleteDashboard(): Promise<void> {
	const dash = state.dash;
	if (!dash) return;
	if (!window.confirm(t("dash.delete_confirm", dash.name))) return;
	state.dashMenu = false;
	const res = await fetch(`/api/dashboards/${encodeURIComponent(dash.id)}`, { method: "DELETE" }).catch(() => null);
	if (res?.ok) location.href = "/dashboards/";
	else toastMsg(t("dash.delete_fail"));
}

function onDashboardsChanged(data: { id: string; widgets: ServerDashboardWidget[]; version: number } | null): void {
	// Saved from another client/window: rebase onto the server copy silently.
	if (!data || data.id !== state.dash?.id) return;
	void resync({ ...state.dash!, widgets: data.widgets, version: data.version });
}

// ----------------------------------------------------------------------- view

const App: m.Component = {
	view() {
		if (state.notFound) {
			return (
				<Page title={t("dash.title")} nav={serverNav("dashboards")}>
					<p class={css({fontSize: "0.875rem", lineHeight: "1.25rem", color: "neutral"})}>{t("dash.not_found")}</p>
				</Page>
			);
		}
		const dash = state.dash;
		return (
			<Page
				title={
					<TitleWithBack href="/dashboards/" backLabel={t("dash.back")}>
						{dash?.name ?? t("dash.title")}
					</TitleWithBack>
				}
				nav={
					dash
						? button(dash && state.editMode ? t("dash.done") : t("dash.edit"), {
							"aria-pressed": state.editMode,
							onclick: () => setEdit(!state.editMode),
						})
						: undefined
				}
				headerRight={
					dash
						? [
							state.saveState === "idle"
								? null
								: <span class={css({fontSize: "0.875rem", lineHeight: "1.25rem", color: "neutral"})}>{t(state.saveState === "saving" ? "dash.saving" : state.saveState === "saved" ? "dash.saved" : "dash.save_error")}</span>,
							<button
								class={css({display: "inline-flex", alignItems: "center", borderRadius: "0.375rem", padding: "0.25rem", "&:hover": {backgroundColor: "neutral/10"}, "&:disabled": {opacity: "0.5"}})}
								type="button"
								title={t(document.fullscreenElement ? "dash.exit_fullscreen" : "dash.fullscreen")}
								aria-label={t(document.fullscreenElement ? "dash.exit_fullscreen" : "dash.fullscreen")}
								aria-pressed={!!document.fullscreenElement}
								disabled={!document.fullscreenEnabled}
								onclick={() => void toggleFullscreen()}
							>
								{actionIcon(document.fullscreenElement ? "exitFullscreen" : "fullscreen")}
							</button>,
						]
						: null
				}
			>
				{dash && [
					state.toast && (
						<div class={css({borderRadius: "0.375rem", borderWidth: "1px", borderColor: "neutral/30", backgroundColor: "neutral/10", paddingInline: "0.75rem", paddingBlock: "0.5rem", fontSize: "0.875rem", lineHeight: "1.25rem"})}>{state.toast}</div>
					),
					state.editMode && (
						<div class={css({display: "flex", alignItems: "center", gap: "0.5rem"})}>
							{button(`+ ${t("dash.add_widget")}`, {
								onclick: () => {
									location.href = `/dashboards/add/${encodeURIComponent(dash.id)}/`;
								},
							})}
						</div>
					),
					<GridDashboardView
						widgets={dash.widgets}
						columns={colsOf(dash)}
						editMode={state.editMode}
						actions={actions}
						onLayout={onLayout}
					/>,
					!dash.widgets.length && <p class={css({fontSize: "0.875rem", lineHeight: "1.25rem", color: "neutral"})}>{t("dash.no_widgets")}</p>,
				]}
				{!dash && <p class={css({fontSize: "0.875rem", lineHeight: "1.25rem", color: "neutral"})}>{t("mgmt.loading")}</p>}
			</Page>
		);
	},
};

// -------------------------------------------------------------------- startup

void (async () => {
	const match = PATH_RE.exec(location.pathname);
	state.editMode = match?.[1] === "edit";
	const id = match?.[2] ?? "";
	const res = await fetch(`/api/dashboards/${encodeURIComponent(id)}`, { cache: "no-store" }).catch(() => null);
	const body = (res?.ok ? await res.json().catch(() => null) : null) as { ok?: boolean; dashboard?: ServerDashboard } | null;
	if (body?.ok && body.dashboard) state.dash = body.dashboard;
	else state.notFound = true;
	setWidgetConfigSaver(() => scheduleSave());
	setDashboardChangedSink(onDashboardsChanged);
	await refreshDevices();
	syncConnectionsFor(state.dash);
	// One-time startup sync: devices.changed then keeps the devices and the
	// widget connections in step, so no polling timer is needed.
	ensureDashboardsWs();
	m.redraw();
})();

document.addEventListener("fullscreenchange", () => m.redraw());
void mountPage(() => t("dash.title"), App);