/* Dashboard page: the merged inline grid editor. Serves both
 * `/dashboards/view/<id>/` (starts read-only) and `/dashboards/edit/<id>/`
 * (starts in edit mode). One GridStack grid renders the live widgets; in edit
 * mode widgets can be dragged/resized and new ones added, hidden, removed,
 * renamed and re-configured. Layout + name changes autosave (debounced) with
 * optimistic concurrency: a 409 reloads the server copy and toasts the conflict.
 * Broadcast `dashboards.changed` events rebase the dashboard from the server. */
import m from "mithril";
import type { ServerDashboard, ServerDashboardWidget, WidgetType } from "../types";
import { Page, serverNav } from "./components/ui";
import {
	devices,
	ensureDashboardsWs,
	independentTypes,
	isIndependent,
	typeLabel,
	refreshDevices,
	setDashboardChangedSink,
	setWidgetConfigSaver,
	syncConnectionsFor,
	widgetSize,
	widgetTypesFor,
	type WidgetActions,
} from "./dashboard";
import { GridDashboard } from "./dashboardgrid";
import { t } from "./i18n";
import { mountPage } from "./util";

const REFRESH_MS = 3_000;
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
	addMenu: false,
	addDevice: "",
	onlineText: t("mgmt.loading"),
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

function onlineText(): string {
	const list = devices.list ?? [];
	return `${list.filter((d) => d.online).length}/${list.length}`;
}

function pickDevice(): string {
	const list = [...(devices.list ?? [])].sort((a, b) => Number(b.online) - Number(a.online));
	return list[0]?.id ?? "";
}

/** Next free (x,y) for a widget of the given size, scanning rows then columns. */
function firstFreePosition(dash: ServerDashboard, size: { w: number; h: number }): { x: number; y: number } {
	const cols = colsOf(dash);
	let maxY = 0;
	const taken = (x: number, y: number): boolean => dash.widgets.some((w) => w.visible && x >= w.x && x < w.x + w.w && y >= w.y && y < w.y + w.h);
	for (const w of dash.widgets) maxY = Math.max(maxY, w.y + w.h);
	for (let y = 0; y <= maxY; y++) {
		for (let x = 0; x <= cols - size.w; x++) {
			let free = true;
			for (let yy = y; yy < y + size.h && free; yy++) for (let xx = x; xx < x + size.w; xx++) if (taken(xx, yy)) { free = false; break; }
			if (free) return { x, y };
		}
	}
	return { x: 0, y: maxY };
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

function addWidget(type: WidgetType): void {
	const dash = state.dash;
if (!dash) return;
	const size = widgetSize(type);
	const { x, y } = firstFreePosition(dash, size.default);
	const widget: ServerDashboardWidget = {
		id: crypto.randomUUID(),
		type,
		deviceId: isIndependent(type) ? "" : state.addDevice || pickDevice(),
		name: "",
		x,
		y,
		w: size.default.w,
		h: size.default.h,
		visible: true,
	};
	if (isIndependent(type)) widget.config = { channel: "", token: "" };
	state.dash = { ...dash, widgets: [...dash.widgets, widget] };
	state.addMenu = false;
	syncConnectionsFor(state.dash);
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
			return m(Page, { title: t("dash.title"), nav: serverNav("dashboards") }, m("p.muted", t("dash.not_found")));
		}
		const dash = state.dash;
		const onlineDevices = [...(devices.list ?? [])].sort((a, b) => Number(b.online) - Number(a.online));
		return m(
			Page,
			{
				title: t("dash.title"),
				nav: serverNav("dashboards"),
				headerRight: [
					m("a.dash-back", { href: "/dashboards/" }, t("dash.back")),
					dash
						? [
								m("span.dash-name-btn", [
									m("button.dash-name", { onclick: () => (state.dashMenu = !state.dashMenu) }, `${dash.name} ▾`),
									state.dashMenu
										? m("div.dash-popup.dash-name-menu", [
												m("button", { onclick: () => void newDashboard() }, t("dash.new")),
												m("button", { onclick: renameDashboard }, t("dash.rename")),
												m("button.danger", { onclick: () => void deleteDashboard() }, t("dash.delete")),
											])
										: null,
								]),
								m("span.dash-add-btn", [
									m("button.dash-add", {
										onclick: () => {
											if (!state.addDevice) state.addDevice = pickDevice();
											state.addMenu = !state.addMenu;
										},
									}, `${t("dash.add_widget")} ▾`),
									state.addMenu
										? m("div.dash-popup.dash-add-menu", [
												onlineDevices.length
													? m(
															"div.dash-add-devices",
															m("select", {
																value: state.addDevice,
																onchange: (e: Event) => (state.addDevice = (e.target as HTMLSelectElement).value),
															}, onlineDevices.map((d) => m("option", { key: d.id, value: d.id }, `${d.hostname || d.id}${d.online ? "" : " · " + t("dev.badge.offline")}`))),
														)
													: null,
												onlineDevices
													.filter((d) => widgetTypesFor(d).length)
													.map((d) =>
														m("div.dash-add-row", { key: d.id }, [
															m("span.dash-add-device", d.hostname || d.id),
															m(
																"span.dash-add-options",
																widgetTypesFor(d).map((type) => m("button.dash-add-opt", { key: type, onclick: () => addWidget(type) }, typeLabel(type))),
															),
														]),
													),
												m("div.dash-add-row.dash-add-kick", [
													m("span.dash-add-device", t("dash.kick")),
													m(
														"span.dash-add-options",
														independentTypes().map((type) => m("button.dash-add-opt", { key: type, onclick: () => addWidget(type) }, typeLabel(type))),
													),
												]),
										])
										: null,
								]),
								m("button.dash-edittoggle", { onclick: () => setEdit(!state.editMode) }, state.editMode ? t("dash.done") : t("dash.edit")),
								m("span.dash-save.dash-save-" + state.saveState, state.saveState === "idle" ? "" : t(state.saveState === "saving" ? "dash.saving" : state.saveState === "saved" ? "dash.saved" : "dash.save_error")),
								m("span.dash-online.muted", state.onlineText),
							]
						: null,
				],
			},
			dash
				? [
						state.toast ? m("div.dash-toast", state.toast) : null,
						m(GridDashboard, {
							widgets: dash.widgets,
							columns: colsOf(dash),
							editMode: state.editMode,
							actions,
							onLayout,
						}),
						dash.widgets.length ? null : m("p.dash-empty.muted", t("dash.no_widgets")),
					]
				: m("p.muted", t("mgmt.loading")),
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
	state.onlineText = onlineText();
	syncConnectionsFor(state.dash);
	ensureDashboardsWs();
	m.redraw();
	setInterval(() => {
		void (async () => {
			await refreshDevices();
			state.onlineText = onlineText();
			syncConnectionsFor(state.dash);
			m.redraw();
		})();
	}, REFRESH_MS);
})();

mountPage(t("dash.title"), App);