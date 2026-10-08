/* The control server's shared live feed (WS /dashboards/ws): the live device
 * list (devices.snapshot on connect, devices.changed on every state change),
 * the dashboard list (dashboards.snapshot / dashboards.changed) and the
 * kick/chat widget frames the dashboard pages subscribe to separately. One
 * auto-reconnecting socket per page; pages register the events they need.
 * Handlers are plain subscribers — callers redraw themselves. */
import type { DeviceSummary, ServerDashboard } from "../../types";
import { RpcClient, socketUrl } from "./rpc";

/** A `dashboards.changed` event: the dashboard object (create/update) or
 * `{id, deleted: true}` (delete). */
export type DashboardsChanged = ServerDashboard | { id: string; deleted: true };

// Absolute path: the subscribers live under / and /dashboards/, a relative
// "dashboards/ws" would resolve to a different URL on each page.
const rpc = new RpcClient(() => socketUrl("/dashboards/ws"));

interface Handlers {
	/** Every devices.snapshot / devices.changed push, in server order. */
	devices?: (list: DeviceSummary[]) => void;
	/** The maintained dashboard list, after a snapshot or change. */
	dashboards?: (list: ServerDashboard[]) => void;
	/** Raw dashboards.changed events before/without the maintained list. */
	dashboardsChanged?: (event: DashboardsChanged) => void;
	open?: () => void;
	close?: () => void;
}

const handlers = new Set<Handlers>();
let dashboards: ServerDashboard[] = [];

const applyDevices = (list: DeviceSummary[]): void => {
	for (const h of handlers) h.devices?.(list);
};

const applyDashboards = (): void => {
	for (const h of handlers) h.dashboards?.([...dashboards]);
};

rpc.on("devices.snapshot", (data) => applyDevices(data as DeviceSummary[]));
rpc.on("devices.changed", (data) => applyDevices(data as DeviceSummary[]));
rpc.on("dashboards.snapshot", (data) => {
	dashboards = (data as { dashboards?: ServerDashboard[] }).dashboards ?? [];
	applyDashboards();
});
rpc.on("dashboards.changed", (data) => {
	const e = data as DashboardsChanged;
	if (e && "deleted" in e && e.deleted) dashboards = dashboards.filter((d) => d.id !== e.id);
	else {
		const i = dashboards.findIndex((d) => d.id === (e as ServerDashboard).id);
		dashboards = i >= 0 ? [...dashboards.slice(0, i), e as ServerDashboard, ...dashboards.slice(i + 1)] : [...dashboards, e as ServerDashboard];
	}
	for (const h of handlers) h.dashboardsChanged?.(e);
	applyDashboards();
});
rpc.on("open", () => { for (const h of handlers) h.open?.(); });
rpc.on("close", () => { for (const h of handlers) h.close?.(); });

export const serverLive = {
	/** The raw client: the dashboard pages register their widget frames here. */
	rpc,
	get connected(): boolean {
		return rpc.open;
	},
	get dashboards(): ServerDashboard[] {
		return [...dashboards];
	},
	on(h: Handlers): () => void {
		handlers.add(h);
		return () => handlers.delete(h);
	},
};
