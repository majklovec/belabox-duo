/**
 * Frontend module registry — the only module entry point public/ts (the device
 * store, dashboards) imports for module cards and event handling.
 *
 * Modules are discovered through a build-time generated manifest
 * (`modules/.generated.frontend.ts`, emitted by `scripts/gen-modules.ts`): one
 * static import per frontend.tsx inside a modules subdirectory, in sorted path
 * order, default-exporting the array. The browser bundle therefore never uses
 * Glob and every module is statically resolved (see REFACTOR-modules.md §4.1).
 * Adding a module directory with a `frontend.tsx` default export registers it
 * here — no frontend-registry edits (regeneration happens automatically).
 *
 * Frontend-only file: the server never imports it (it mounts the device store
 * at module init). Kept in src/ so the module code stays out of the core import
 * graph.
 */
import m from "mithril";
import type { ServerDashboardWidget, Status } from "../public/types";
import { setFrontendEventSink, type DeviceCard } from "../public/ts/device/store";
import MANIFEST from "../modules/.generated.frontend";

/** Frontend descriptor of a self-contained widget module (local copy of the
 * documented shape; the core names the shape, modules never import it). */
interface ChannelWidgetModule<TWidget = unknown, TLive = unknown> {
	id: string;
	kind: "widget";
	configFields: readonly string[];
	channelOf(w: TWidget): string;
	body(w: TWidget, live: TLive): unknown;
	badge(w: TWidget, live: TLive): unknown;
}

/** A browser-side module registration (device card). Local copy: the core
 * names the shape, modules never import across boundaries. */
export interface FrontendModule {
	id: string;
	title: string;
	icon?: string;
	kind: "device-card";
	component: (status: Status) => m.Vnode;
	/** Optional card body rendered inside a dashboard widget (the device page
	 * always uses `component`). Lets the core compose per-device widgets without
	 * importing the module directly (REFACTOR-modules.md §5). */
	cardBody?(host: DeviceCard, status: Status): m.Vnode;
	defaultSize: { w: number; h: number };
	minSize: { w: number; h: number };
	maxSize?: { w: number; h: number };
	handleEvent?(event: string, data: unknown): void;
}

type FrontendRegistration = FrontendModule | ChannelWidgetModule<ServerDashboardWidget>;

// The manifest default-exports the registration objects (each module's default export).
const registrations = MANIFEST as unknown as FrontendRegistration[];

const isRegistration = (mod: unknown): mod is FrontendRegistration =>
	typeof mod === "object" &&
	mod !== null &&
	typeof (mod as FrontendRegistration).id === "string" &&
	typeof (mod as FrontendRegistration).kind === "string";

export const FRONTS = registrations.filter(isRegistration);

export const FRONTEND_MODULES: FrontendModule[] = FRONTS.filter(
	(mod): mod is FrontendModule => mod.kind === "device-card",
) as FrontendModule[];

export function getFrontendModule(id: string): FrontendModule | undefined {
	return FRONTEND_MODULES.find((mod) => mod.id === id);
}

export function frontendModuleIds(): string[] {
	return FRONTEND_MODULES.map((mod) => mod.id);
}

export const WIDGET_MODULES = FRONTS.filter(
	(mod): mod is ChannelWidgetModule<ServerDashboardWidget> => mod.kind === "widget",
) as ChannelWidgetModule<ServerDashboardWidget>[];

export function widgetModule(id: string): ChannelWidgetModule<ServerDashboardWidget> | undefined {
	return WIDGET_MODULES.find((wm) => wm.id === id);
}

export function moduleCard(id: string, status: Status): m.Vnode | null {
	const mod = getFrontendModule(id);
	if (!mod) return null;
	return mod.component(status);
}

/** A device module's dashboard-widget card body (the device page uses
 * `component` instead; `cardBody` is the widget variant). Modules that have
 * no separate widget body return null and the dashboard falls back. */
export function deviceCardBody(id: string, host: DeviceCard, status: Status): m.Vnode | null {
	const mod = getFrontendModule(id);
	return mod?.cardBody?.(host, status) ?? null;
}

// Dispatch a pushed event to every frontend module that handles it.
export function dispatchFrontendEvent(event: string, data: unknown): void {
	for (const mod of FRONTEND_MODULES) mod.handleEvent?.(event, data);
}

// Register this dispatcher with the device store. The store is imported from
// module frontends, so it cannot import this registry back (cycle); this is
// the one direction allowed.
setFrontendEventSink(dispatchFrontendEvent);
