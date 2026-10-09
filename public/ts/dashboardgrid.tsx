/* GridStack ↔ Mithril bridge for the dashboard grid. GridStack owns the
 * `.grid-stack-item` DOM (position + drag/resize); Mithril owns the inner live
 * widget content, mounted into each item's `.grid-stack-item-content`. The page
 * passes its reactive `widgets` array; here we reconcile the grid to it. */
import { GridStack, type GridStackWidget } from "gridstack";
import m from "mithril";
import type { ServerDashboardWidget } from "../types";
import { widgetInner, widgetSize, type WidgetActions } from "./dashboard";

export interface GridProps {
	widgets: ServerDashboardWidget[];
	columns: number;
	editMode: boolean;
	actions: WidgetActions;
	/** Called with the full widgets list (positions applied) after a drag/resize. */
	onLayout: (widgets: ServerDashboardWidget[]) => void;
}

interface Manager {
	host: HTMLElement | null;
	grid: GridStack | null;
	current: GridProps | null;
	mounted: Map<string, HTMLElement>;
}
const manager: Manager = { host: null, grid: null, current: null, mounted: new Map() };

function contentEl(item: Element): HTMLElement {
	if (!item) return item as HTMLElement;
	return (item.querySelector(":scope > .grid-stack-item-content") ?? item) as HTMLElement;
}

function renderWidget(id: string): m.Vnode {
	const cur = manager.current;
	const w = cur?.widgets.find((x) => x.id === id);
	// The widget may be gone/hidden between event and redraw: render an empty card.
	if (!w) return m("div.dash-widget");
	const actions = cur?.actions ?? ({ remove: () => {}, hide: () => {} } as WidgetActions);
	return widgetInner(w, cur?.editMode ?? false, actions);
}

function desiredNodes(widgets: ServerDashboardWidget[]): GridStackWidget[] {
	return widgets.filter((w) => w.visible).map((w) => {
		const size = widgetSize(w.type);
		const node: GridStackWidget = { id: w.id, x: w.x, y: w.y, w: w.w, h: w.h, minW: size.min.w, minH: size.min.h, content: "" };
		if (size.max) { node.maxW = size.max.w; node.maxH = size.max.h; }
		return node;
	});
}

/** Push gridstack positions back into the widgets list (by id) after a change. */
function commitLayout(): void {
	const cur = manager.current;
	const grid = manager.grid;
	if (!cur || !grid) return;
	const byId = new Map(grid.engine.nodes.map((n) => [n.id, n]));
	const widgets = cur.widgets.map((w) => {
		const n = byId.get(w.id);
		return n ? { ...w, x: n.x ?? w.x, y: n.y ?? w.y, w: n.w ?? w.w, h: n.h ?? w.h } : w;
	});
	cur.onLayout(widgets);
}

function reconcile(): void {
	const grid = manager.grid;
	const cur = manager.current;
	if (!grid || !cur) return;
	// Re-load the grid ONLY when the set of visible widgets changes (add,
	// remove, hide, un-hide). A pure drag/resize already moved the node inside
	// GridStack; re-running `grid.load` would re-pack the layout and drift the
	// positions we just read back.
	const desired = cur.widgets.filter((w) => w.visible).map((w) => w.id).sort().join("\0");
	const presentBefore = grid.engine.nodes.map((n) => n.id as string).sort().join("\0");
	if (desired !== presentBefore) grid.load(desiredNodes(cur.widgets), true);

	const present = new Set(grid.engine.nodes.map((n) => n.id as string));
	for (const n of grid.engine.nodes) {
		const id = n.id;
		const item = n.el as HTMLElement | undefined;
		if (!id || !item) continue;
		const el = manager.mounted.get(id);
		if (el && el.parentElement === item) continue;   // already mounted & in place
		const root = contentEl(item);
		manager.mounted.set(id, root);
		m.mount(root, { view: () => renderWidget(id) });
	}
	// Unmount items that are no longer visible/present.
	for (const id of [...manager.mounted.keys()]) {
		if (!present.has(id)) {
			m.mount(manager.mounted.get(id)!, null);
			manager.mounted.delete(id);
		}
	}
}

function setEditMode(editMode: boolean): void {
	// Drag/resize are only allowed in edit mode.
	manager.grid?.enableMove(editMode);
	manager.grid?.enableResize(editMode);
}

function teardownGrid(): void {
	for (const el of manager.mounted.values()) m.mount(el, null);
	manager.mounted.clear();
	manager.grid?.destroy(true);
	manager.grid = null;
	manager.host = null;
	manager.current = null;
}

export const GridDashboard: m.Component<GridProps> = {
	view(vnode) {
		return m("div.grid-stack.dash-grid", {
			oncreate: (vd: m.VnodeDOM) => {
				teardownGrid();
				manager.host = vd.dom as HTMLElement;
				manager.current = vnode.attrs;
				const grid = new GridStack(manager.host, {
					column: vnode.attrs.columns,
					cellHeight: 60,
					margin: 6,
					float: false,
					disableDrag: !vnode.attrs.editMode,
					disableResize: !vnode.attrs.editMode,
					draggable: { handle: ".dash-grip" },
				});
				grid.on("dragstop", commitLayout);
				grid.on("resizestop", commitLayout);
				manager.grid = grid;
				setEditMode(vnode.attrs.editMode);
				reconcile();
			},
			onupdate: () => {
				const prev = manager.current;
				manager.current = vnode.attrs;
				if (!prev || prev.editMode !== vnode.attrs.editMode || (prev.widgets !== vnode.attrs.widgets)) reconcile();
				setEditMode(vnode.attrs.editMode);
			},
			onremove: () => teardownGrid(),
		});
	},
};