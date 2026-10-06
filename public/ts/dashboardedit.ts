/* Dashboard edit page: rename, compose and persist a dashboard (name, widgets,
 * order, widths). Live widgets are reused from the shared dashboard module. */
import m from "mithril";
import type { ServerDashboard, WidgetType } from "../types";
import { badge, button, Card, input, options, Page, select, serverNav } from "./components/ui";
import {
	deviceById,
	deviceLabel,
	devices,
	refreshDevices,
	syncConnectionsFor,
	typeLabel,
	widgetTypesFor,
	widgetView,
	isIndependent,
	independentTypes,
	setWidgetConfigSaver,
} from "./dashboard";
import { t } from "./i18n";
import { mountPage } from "./util";

const REFRESH_MS = 3_000;
const WIDTHS = [4, 6, 12] as const;

const id = location.pathname.match(/\/dashboards\/(?:edit|view)\/([^/]+)\/?$/)?.[1] ?? "";

const state = {
	dash: undefined as ServerDashboard | undefined,
	notFound: false,
	onlineText: t("mgmt.loading"),
	name: "",
	// add-widget row; addWidth is kept as a string, matching the select's binding
	addDeviceId: "",
	addType: "" as WidgetType | "",
	addName: "",
	addChannel: "",
	addToken: "",
	addWidth: "6",
	saving: false,
};

async function refresh(): Promise<void> {
	await refreshDevices();
	const list = devices.list ?? [];
	state.onlineText = `${list.filter((d) => d.online).length}/${list.length}`;
}

async function load(): Promise<void> {
	const res = await fetch(`/api/dashboards/${encodeURIComponent(id)}`, { cache: "no-store" }).catch(() => null);
	const body = (res?.ok ? await res.json().catch(() => null) : null) as { ok?: boolean; dashboard?: ServerDashboard } | null;
	if (body?.ok && body.dashboard) {
		state.dash = body.dashboard;
		state.name = body.dashboard.name;
	} else {
		state.notFound = true;
	}
}

/** Persist name+widgets; adopt the canonical copy the server returns. */
async function save(dash: ServerDashboard): Promise<void> {
	state.saving = true;
	m.redraw();
	try {
		const res = await fetch(`/api/dashboards/${encodeURIComponent(dash.id)}`, {
			method: "PUT",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ name: state.name.trim() || dash.name, widgets: dash.widgets }),
		});
		if (!res.ok) {
			const body = (await res.json().catch(() => null)) as { error?: string } | null;
			throw new Error(body?.error ?? `HTTP ${res.status}`);
		}
		state.dash = (await res.json()).dashboard;
	} catch (err) {
		console.error("dashboard save:", err);
	} finally {
		state.saving = false;
		m.redraw();
	}
}

const renamed = () => {
	const dash = state.dash;
	if (state.saving || !dash || !state.name.trim() || state.name.trim() === dash.name) return;
	void save(dash);
};

function addWidget(): void {
	const dash = state.dash;
	if (!dash || !state.addType) return;
	const type = state.addType;
	const width = Number(state.addWidth);
	const w: ServerDashboard["widgets"][number] = {
		// id is assigned by the server on save
		id: "",
		deviceId: isIndependent(type) ? "" : state.addDeviceId,
		type,
		name: state.addName.trim() || typeLabel(type),
		width: WIDTHS.includes(width as 4 | 6 | 12) ? (width as 4 | 6 | 12) : 6,
	};
	if (isIndependent(type)) {
		w.config = { channel: state.addChannel.trim(), token: state.addToken.trim() };
	}
	dash.widgets.push(w);
	state.addName = "";
	state.addChannel = "";
	state.addToken = "";
	void save(dash);
}

/** Persist one kick widget's channel/token after an inline edit. */
function saveWidgetConfig(dash: ServerDashboard, w: ServerDashboard["widgets"][number]): void {
	// Older dashboards saved before the widget carried a config
	if (!w.config) w.config = { channel: "", token: "" };
	w.config.channel = w.config.channel.trim();
	w.config.token = w.config.token.trim();
	void save(dash);
}

function moveWidget(dash: ServerDashboard, index: number, delta: number): void {
	const to = index + delta;
	if (to < 0 || to >= dash.widgets.length) return;
	const [w] = dash.widgets.splice(index, 1);
	dash.widgets.splice(to, 0, w);
	void save(dash);
}

function removeWidget(dash: ServerDashboard, index: number): void {
	dash.widgets.splice(index, 1);
	void save(dash);
}

// ---------------------------------------------------------------------- widgets

/**
 * Add-widget type options: the selected device's modules plus the device-
 * independent kick widgets (always offered; their data source is the channel
 * configured on the widget itself, fetched by the server).
 */
function typeOptions(): m.Vnode[] {
	const device = devices.list?.find((d) => d.id === state.addDeviceId);
	const deviceGroups: m.Vnode[] = device
		? [
				m(
					"optgroup",
					{ key: "device", label: deviceLabel(device) },
					options(widgetTypesFor(device).map((x) => [x, typeLabel(x)] as [string, string])),
				),
			]
		: [];
	const indep = independentTypes();
	return [
		m("option", { key: "", value: "" }, t("dash.widget_type")),
		...deviceGroups,
		indep.length
			? m(
					"optgroup",
					{ key: "independent", label: t("dash.grp_independent") },
					options(indep.map((x) => [x, typeLabel(x)] as [string, string])),
				)
			: null,
	].filter((v): v is m.Vnode => v !== null);
}

function widgetsTable(dash: ServerDashboard): m.Vnode {
	return m(
		"table.dash-table",
		m(
			"thead",
			m("tr", m("th", t("dash.name")), m("th", t("dash.widget_device")), m("th", t("dash.widget_type")), m("th", t("dash.width")), m("th")),
		),
		m(
			"tbody",
			dash.widgets.map((w, i) =>
				m(
					"tr",
					{ key: w.id || `${w.deviceId}:${w.type}:${w.name}` },
					m("td", w.name),
					isIndependent(w.type)
						? m("td", [
								m("input.dash-config-input", {
									value: w.config?.channel ?? "",
									placeholder: t("dash.widget_channel"),
									onblur: () => saveWidgetConfig(dash, w),
									onkeydown: (e: KeyboardEvent) => {
										if (e.key === "Enter") (e.target as HTMLInputElement).blur();
									},
								}),
								w.type === "kick-chat"
									? m("input.dash-config-input", {
											value: w.config?.token ?? "",
											placeholder: t("dash.widget_token"),
											onblur: () => saveWidgetConfig(dash, w),
											onkeydown: (e: KeyboardEvent) => {
												if (e.key === "Enter") (e.target as HTMLInputElement).blur();
											},
										})
									: null,
							])
						: m("td", !deviceById(w.deviceId) ? "—" : deviceLabel(deviceById(w.deviceId)!)),
					m("td.muted", typeLabel(w.type)),
					m("td.muted", t(`dash.width_${w.width}`)),
					m(
						"td.actions-cell",
						button(t("dash.move_up"), { title: t("dash.move_up"), onclick: () => moveWidget(dash, i, -1) }),
						button(t("dash.move_down"), { title: t("dash.move_down"), onclick: () => moveWidget(dash, i, 1) }),
						button(t("dash.delete"), { title: t("dash.delete"), onclick: () => removeWidget(dash, i) }),
					),
				),
			),
		),
	);
}

function addToolbar(dash: ServerDashboard): m.Vnode {
	const type = state.addType;
	const indep = type !== "" && isIndependent(type);
	const canAdd = type !== "" && (indep ? state.addChannel.trim() !== "" : Boolean(state.addDeviceId));
	return m(
		"div.dash-toolbar",
		input(state, "addName", { placeholder: t("dash.name") }) as m.Vnode,
		indep
			? m("div", { class: "dash-add-channel" }, [
					m("input", {
						value: state.addChannel,
						placeholder: t("dash.widget_channel"),
						oninput: (e: InputEvent) => (state.addChannel = (e.target as HTMLInputElement).value),
					}),
					type === "kick-chat"
						? m("input", {
								value: state.addToken,
								placeholder: t("dash.widget_token"),
								oninput: (e: InputEvent) => (state.addToken = (e.target as HTMLInputElement).value),
							})
						: null,
				])
			: select(state, "addDeviceId", options([
					["", t("dash.widget_device")],
					...(devices.list ?? []).map((d) => [d.id, deviceLabel(d)] as [string, string]),
				])) as m.Vnode,
		select(state, "addType", typeOptions()) as m.Vnode,
		select(state, "addWidth", options(WIDTHS.map((w) => [String(w), t(`dash.width_${w}`)] as [string, string]))) as m.Vnode,
		button(t("dash.add_widget"), { onclick: () => addWidget(), disabled: state.saving || !canAdd }),
	);
}

// ------------------------------------------------------------------------ page

const App: m.Component = {
	view() {
		if (state.notFound) {
			return m(Page, { title: t("dash.title"), nav: serverNav("dashboards") }, m(Card, { title: t("dash.title") }, badge(t("dash.not_found"), "warn")));
		}
		const dash = state.dash;
		return m(
			Page,
			{
				title: t("dash.title"),
				nav: serverNav("dashboards"),
				headerRight: [
					m("span.muted", [t("dash.devices"), " ", state.onlineText]),
					m("a.dash-row-link", { href: `/dashboards/` }, t("dash.back")),
					dash ? m("a.dash-row-link", { href: `/dashboards/view/${encodeURIComponent(dash.id)}/` }, t("dash.view")) : null,
				],
			},
			!dash
				? m(Card, { title: t("dash.title") }, m("p.muted", t("mgmt.loading")))
				: m(
						Card,
						{
							title: input(state, "name", {
							class: "dash-name-input",
							onblur: renamed,
							onkeydown: (e: KeyboardEvent) => {
								if (e.key === "Enter") (e.target as HTMLInputElement).blur();
							},
						}) as m.Vnode,
							headActions: state.saving ? badge(t("dash.saving"), "warn") : null,
						},
						dash.widgets.length ? widgetsTable(dash) : m("p.muted", t("dash.no_widgets")),
						addToolbar(dash),
						dash.widgets.length ? m("div.dashboard-grid", dash.widgets.map(widgetView)) : null,
					),
		);
	},
};

void (async () => {
	await load();
	// Pencil "settings" on a kick widget shares the inline table save path.
	setWidgetConfigSaver((w) => {
		if (state.dash) saveWidgetConfig(state.dash, w);
	});
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
