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

/** Render context the core hands a widget module: the live state bag of the
 * widget's own device (undefined for device-independent widgets). Lets a module
 * read the device state it composes (e.g. srtla stats) without the core naming a
 * module's renderer. `deviceLive` is the core's per-device live data (its own
 * `DeviceLive` bag, read structurally); `device` is the device info. */
export interface WidgetContext {
	deviceLive?: Record<string, unknown> | null;
	device?: Record<string, unknown> | null;
}

/** Frontend descriptor of a self-contained widget module (local copy of the
 * documented shape; the core names the shape, modules never import it).
 *
 * The module owns its live state (its own per-channel map), fed by `onFrame`;
 * `body`/`badge` render from it plus, where relevant, the widget's device state
 * in `ctx`. `body`/`badge` take the widget only — no separate `live` argument —
 * so the core never has to resolve which live map a widget type reads. */
interface ChannelWidgetModule<TWidget = unknown> {
	id: string;
	kind: "widget";
	/** Widget types this module composes; the core routes by this, not by a
	 * hard-coded type→module table. */
	widgetTypes: readonly string[];
	/** Grid cell count for a widget of this module's types (grid policy). */
	defaultSize: { w: number; h: number };
	configFields: readonly string[];
	channelOf(w: TWidget): string;
	body(w: TWidget, ctx: WidgetContext): unknown;
	badge(w: TWidget, ctx: WidgetContext): unknown;
	/** Optional: receive one dashboard-websocket frame and fold it into the
	 * module's own live state (chat modules are fed this way; device-liveness
	 * widgets read `ctx` instead and omit it). */
	onFrame?(event: string, data: unknown): void;
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

const isRegistration = (mod: unknown): mod is FrontendRegistration =>
	typeof mod === "object" &&
	mod !== null &&
	typeof (mod as FrontendRegistration).id === "string" &&
	typeof (mod as FrontendRegistration).kind === "string";

// The manifest default-exports each module's default export, which is a single
// registration or an array of them (a module can register a device-card plus one
// or more dashboard widgets); flatten to one registration per entry.
const registrations = (
	MANIFEST as unknown as (FrontendRegistration | FrontendRegistration[])[]
).flat().filter(isRegistration);

export const FRONTS = registrations;

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

/** Widget type → the module that composes it, declared by the module's
 * `widgetTypes`. The core routes a widget type through this table — it names no
 * module itself. */
const WIDGET_TYPE_TO_MODULE = new Map<string, ChannelWidgetModule<ServerDashboardWidget>>();
for (const wm of WIDGET_MODULES)
	for (const type of wm.widgetTypes ?? []) WIDGET_TYPE_TO_MODULE.set(type, wm);

export function widgetModuleForType(type: string): ChannelWidgetModule<ServerDashboardWidget> | undefined {
	return WIDGET_TYPE_TO_MODULE.get(type);
}

/** The widget types the registered modules compose. */
export function widgetModuleTypes(): string[] {
	return [...WIDGET_TYPE_TO_MODULE.keys()];
}

/** Forward one dashboard-websocket frame to every widget module's `onFrame`.
 * Each module folds the frames it cares into its own live state and ignores the
 * rest, so the core stays free of per-platform frame parsing. */
export function dispatchWidgetFrame(event: string, data: unknown): void {
	for (const wm of WIDGET_MODULES) wm.onFrame?.(event, data);
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
