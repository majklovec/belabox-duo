/* Dedicated "add widget" page: /dashboards/add/<id>/. The dashboard's
 * "Add widget" button links here; picking a type (per device group or an
 * independent kick widget) and an optional name replaces the old in-page
 * dropdown. The device is carried by the option itself (its group), and
 * type-specific config (e.g. the kick channel) is set through the widget's
 * own config editor after it lands on the grid. The widget lands on the next
 * free grid slot and the page returns to the (live) dashboard view. A 409
 * conflict reloads the server copy; the widget is not added twice. */
import m from "mithril";
import type { ServerDashboard, ServerDashboardWidget, WidgetType } from "../types";
import { Page, button, field, fieldGroup, input, serverNav } from "./components/ui";
import {
	devices,
	independentTypes,
	isIndependent,
	typeLabel,
	refreshDevices,
	widgetSize,
	widgetTypesFor,
} from "./dashboard";
import { widgetModule } from "../../src/registry.frontend";
import { t } from "./i18n";
import { mountPage } from "./util";

const ADD_PATH_RE = /\/dashboards\/add\/([^/]+)\/?$/;

type SaveState = "idle" | "saving" | "saved" | "error";

const state = {
	dash: undefined as ServerDashboard | undefined,
	notFound: false,
	type: "" as WidgetType | "",
	/** The device the picked type's option came from ("" when independent). */
	device: "",
	/** The picked type's config parameter values (module-declared fields). */
	config: {} as Record<string, string>,
	saveState: "idle" as SaveState,
};

// -------------------------------------------------------------------- helpers

/** The next free (x,y) for a widget of the given size, scanning rows then columns. */
function firstFreePosition(dash: ServerDashboard, size: { w: number; h: number }): { x: number; y: number } {
	const cols = dash.columns ?? 12;
	let maxY = 0;
	const taken = (x: number, y: number): boolean =>
		dash.widgets.some((w) => w.visible && x >= w.x && x < w.x + w.w && y >= w.y && y < w.y + w.h);
	for (const w of dash.widgets) maxY = Math.max(maxY, w.y + w.h);
	for (let y = 0; y <= maxY; y++) {
		for (let x = 0; x <= cols - size.w; x++) {
			let free = true;
			for (let yy = y; yy < y + size.h && free; yy++)
				for (let xx = x; xx < x + size.w; xx++)
					if (taken(xx, yy)) {
						free = false;
						break;
					}
			if (free) return { x, y };
		}
	}
	return { x: 0, y: maxY };
}

const sortedDevices = () => [...(devices.list ?? [])].sort((a, b) => Number(b.online) - Number(a.online));

/** The widget types offered, grouped per device — the group *is* the device —
 * plus the independent kick types. */
function typeGroups(): { device: string; label: string; types: WidgetType[] }[] {
	return [
		...sortedDevices()
			.filter((d) => widgetTypesFor(d).length)
			.map((d) => ({ device: d.id, label: d.hostname || d.id, types: widgetTypesFor(d) })),
		{ device: "", label: t("dash.grp_independent"), types: independentTypes() },
	];
}

/** The picked type's trimmed config parameters (`config` for the widget row) —
 * only types whose module declares fields get one. */
function widgetConfigFor(type: WidgetType): { config: Record<string, string> } | {} {
	const fields = widgetModule(type)?.configFields ?? [];
	if (fields.length === 0) return {};
	return { config: Object.fromEntries(fields.map((name) => [name, (state.config[name] ?? "").trim()])) };
}

const optionValue = (device: string, type: WidgetType): string => (device ? `${device}|${type}` : type);

/** The select value for the current choice ("" while nothing is picked). */
function selectedValue(): string {
	if (!state.type) return "";
	if (!isIndependent(state.type))
		return devices.list?.some((d) => d.id === state.device) ? optionValue(state.device, state.type) : "";
	return state.type;
}

function onTypeChange(value: string): void {
	const sep = value.lastIndexOf("|");
	if (sep >= 0) {
		const deviceId = value.slice(0, sep);
		const ty = (value.slice(sep + 1) || "") as WidgetType | "";
		// Guard against a device that no longer offers the picked type.
		const d = (devices.list ?? []).find((dd) => dd.id === deviceId);
		if (d && ty !== "" && widgetTypesFor(d).includes(ty)) {
			state.device = deviceId;
			state.type = ty;
			state.config = {};
			return;
		}
	}
	state.device = "";
	state.type = value === "" || isIndependent(value as WidgetType) ? (value as WidgetType | "") : "";
	state.config = {};
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
		name: typeLabel(type),
		x,
		y,
		w: size.default.w,
		h: size.default.h,
		visible: true,
		...widgetConfigFor(type),
	};
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
			return (
				<Page title={t("dash.title")} nav={serverNav("dashboards")}>
					<p class={"muted"}>{t("dash.not_found")}</p>
				</Page>
			);
		}
		if (!dash)
			return (
				<Page title={t("dash.title")} nav={serverNav("dashboards")}>
					<p class={"muted"}>{t("mgmt.loading")}</p>
				</Page>
			);

		const type = state.type;
		const groups = typeGroups();
		return (
			<Page
				title={t("dash.title")}
				headerRight={[
					<a class={"dash-back"} href={"/dashboards/"}>
						{t("dash.back")}
					</a>,
					<span class={"dash-name"}>{` ${t("dash.add_widget")} · ${dash.name}`}</span>,
				]}
			>
				<div class={"dash-add-page"}>
					{[
						<h2 class={"dash-add-heading"}>{t("dash.add_widget")}</h2>,
						<form
							class={"dash-add-form"}
							onsubmit={(e: Event) => {
								e.preventDefault();
								void submit();
							}}
						>
							{[
								field(
									t("dash.widget_type"),
									<select
										value={selectedValue()}
										onchange={(e: Event) => onTypeChange((e.target as HTMLSelectElement).value)}
									>
										{[
											...groups.map((g) => (
												<optgroup key={g.label} label={g.label}>
													{g.types.map((ty) => (
														<option
															key={optionValue(g.device, ty)}
															value={optionValue(g.device, ty)}
														>
															{typeLabel(ty)}
														</option>
													))}
												</optgroup>
											)),
										]}
									</select>,
								),
								...(type
									? (widgetModule(type)?.configFields ?? []).map((name) =>
											field(
												t(`dash.widget_${name}`),
												input(state.config, name, {
													type: "text",
													placeholder: t(`dash.widget_${name}`),
												}),
											),
										)
									: []),
								<div class={"dash-config-actions dash-add-actions"}>
									{[
										button(t("dash.add"), {
											type: "submit",
											disabled: state.saveState === "saving",
										}),
										state.saveState === "saving" ? (
											<span class={"dash-save dash-save-saving"}>{t("dash.saving")}</span>
										) : null,
										state.saveState === "error" ? (
											<span class={"dash-save dash-save-error"}>{t("dash.save_error")}</span>
										) : null,
									]}
								</div>,
							]}
						</form>,
					]}
				</div>
			</Page>
		);
	},
};

// -------------------------------------------------------------------- startup

void (async () => {
	const id = ADD_PATH_RE.exec(location.pathname)?.[1] ?? "";
	const res = await fetch(`/api/dashboards/${encodeURIComponent(id)}`, { cache: "no-store" }).catch(() => null);
	const body = (res?.ok ? await res.json().catch(() => null) : null) as {
		ok?: boolean;
		dashboard?: ServerDashboard;
	} | null;
	if (body?.ok && body.dashboard) state.dash = body.dashboard;
	else state.notFound = true;
	void mountPage(() => t("dash.title"), App);
	await refreshDevices();
	m.redraw();
})();
