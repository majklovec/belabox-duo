/* Dedicated "add widget" page: /dashboards/add/<id>/. The dashboard's
 * "Add widget" button links here; picking a type (per device or an
 * independent kick widget) and its settings — device and channel — replaces
 * the old in-page dropdown. The widget lands on the next free grid slot and
 * the page returns to the (live) dashboard view. A 409 conflict reloads the
 * server copy; the widget is not added twice. */
import m from "mithril";
import type { DeviceSummary, ServerDashboard, ServerDashboardWidget, WidgetType } from "../types";
import { Page, button, field, fieldGroup, input, select, serverNav } from "./components/ui";
import { devices, independentTypes, isIndependent, typeLabel, refreshDevices, widgetSize, widgetTypesFor } from "./dashboard";
import { t } from "./i18n";
import { mountPage } from "./util";

const ADD_PATH_RE = /\/dashboards\/add\/([^/]+)\/?$/;

type SaveState = "idle" | "saving" | "saved" | "error";

const state = {
	dash: undefined as ServerDashboard | undefined,
	notFound: false,
	type: "" as WidgetType | "",
	device: "",
	name: "",
	channel: "",
	saveState: "idle" as SaveState,
};

// -------------------------------------------------------------------- helpers

/** The next free (x,y) for a widget of the given size, scanning rows then columns. */
function firstFreePosition(dash: ServerDashboard, size: { w: number; h: number }): { x: number; y: number } {
	const cols = dash.columns ?? 12;
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

const sortedDevices = () => [...(devices.list ?? [])].sort((a, b) => Number(b.online) - Number(a.online));

/** The widget types offered, grouped per device plus the independent kick types. */
function typeGroups(): { label: string; types: WidgetType[] }[] {
	return [
		...sortedDevices().filter((d) => widgetTypesFor(d).length).map((d) => ({ label: d.hostname || d.id, types: widgetTypesFor(d) })),
		{ label: t("dash.grp_independent"), types: independentTypes() },
	];
}

/** The devices that offer the picked type (none when independent). */
function devicesFor(type: WidgetType): DeviceSummary[] {
	if (isIndependent(type)) return [];
	return (devices.list ?? []).filter((d) => widgetTypesFor(d).includes(type));
}

function onTypeChange(type: string): void {
	const ty = (type || "") as WidgetType | "";
	state.type = ty;
	state.device = ty ? (devicesFor(ty)[0]?.id ?? "") : "";
}

function onDeviceChange(device: string): void {
	const ty = state.type;
	if (!ty) return;
	// Guard against a device that no longer offers the picked type.
	const offering = devicesFor(ty);
	state.device = offering.some((d) => d.id === device) ? device : offering[0]?.id ?? "";
}

// ---------------------------------------------------------------------- save

async function submit(): Promise<void> {
	const dash = state.dash;
	const type = state.type;
	if (!dash || !type || state.saveState === "saving") return;
	if (!isIndependent(type) && !state.device) return;
	const size = widgetSize(type);
	const { x, y } = firstFreePosition(dash, size.default);
	const widget: ServerDashboardWidget = {
		id: crypto.randomUUID(),
		type,
		deviceId: isIndependent(type) ? "" : state.device,
		name: state.name.trim() || typeLabel(type),
		x,
		y,
		w: size.default.w,
		h: size.default.h,
		visible: true,
	};
	if (isIndependent(type)) widget.config = { channel: state.channel.trim(), token: "" };
	state.saveState = "saving";
	m.redraw();
	const res = await fetch(`/api/dashboards/${encodeURIComponent(dash.id)}`, {
		method: "PUT",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify({ name: dash.name, widgets: [...dash.widgets, widget], version: dash.version }),
	}).catch(() => null);
	if (res?.status === 409) {
		const conflict = (await res.json().catch(() => null)) as { current?: ServerDashboard } | null;
		if (conflict?.current) state.dash = conflict.current; // rebase; the widget was not added
		state.saveState = "error";
		m.redraw();
		return;
	}
	state.saveState = res?.ok ? "saved" : "error";
	m.redraw();
	if (res?.ok) location.href = `/dashboards/view/${encodeURIComponent(dash.id)}/`;
}

// ---------------------------------------------------------------------- view

const App: m.Component = {
	view() {
		const dash = state.dash;
		if (state.notFound) {
			return m(Page, { title: t("dash.title"), nav: serverNav("dashboards") }, m("p.muted", t("dash.not_found")));
		}
		if (!dash) return m(Page, { title: t("dash.title"), nav: serverNav("dashboards") }, m("p.muted", t("mgmt.loading")));

		const type = state.type;
		const offlineTag = (id: string) => (devices.list?.find((d) => d.id === id)?.online ? "" : ` · ${t("dev.badge.offline")}`);
		const groups = typeGroups();
		return m(
			Page,
			{
				title: t("dash.title"),
				nav: serverNav("dashboards"),
				headerRight: [
					m("a.dash-back", { href: "/dashboards/" }, t("dash.back")),
					m("span.dash-name", ` ${t("dash.add_widget")} · ${dash.name}`),
				],
			},
			m("div.dash-add-page", [
				m("h2.dash-add-heading", t("dash.add_widget")),
				m(
					"form.dash-add-form",
					{
						onsubmit: (e: Event) => {
							e.preventDefault();
							void submit();
						},
					},
					[
						field(
							t("dash.widget_type"),
							select(
								state,
								"type",
								[
									m("option", { key: "", value: "" }, "…"),
									...groups.map((g) =>
										m(
											"optgroup",
											{ key: g.label, label: g.label },
											g.types.map((ty) => m("option", { key: ty, value: ty }, typeLabel(ty))),
										),
									),
								],
								{},
								onTypeChange,
							),
						),
						type
							? isIndependent(type)
								? field(t("dash.widget_channel"), input(state, "channel", { type: "text", placeholder: "xqc" }))
								: field(
										t("dash.widget_device"),
										select(state, "device", devicesFor(type).map((d) => m("option", { key: d.id, value: d.id }, `${d.hostname || d.id}${offlineTag(d.id)}`)), {}, (v) => onDeviceChange(v)),
									)
							: null,
						field(t("dash.name"), input(state, "name", { type: "text", placeholder: type ? typeLabel(type) : "", maxlength: 60 })),
						m("div.dash-config-actions.dash-add-actions", [
							button(t("dash.add"), { type: "submit", disabled: state.saveState === "saving" }),
							state.saveState === "saving" ? m("span.dash-save.dash-save-saving", t("dash.saving")) : null,
							state.saveState === "error" ? m("span.dash-save.dash-save-error", t("dash.save_error")) : null,
						]),
					],
				),
			]),
		);
	},
};

// -------------------------------------------------------------------- startup

void (async () => {
	const id = ADD_PATH_RE.exec(location.pathname)?.[1] ?? "";
	const res = await fetch(`/api/dashboards/${encodeURIComponent(id)}`, { cache: "no-store" }).catch(() => null);
	const body = (res?.ok ? await res.json().catch(() => null) : null) as { ok?: boolean; dashboard?: ServerDashboard } | null;
	if (body?.ok && body.dashboard) state.dash = body.dashboard;
	else state.notFound = true;
	mountPage(t("dash.title"), App);
	await refreshDevices();
	m.redraw();
})();