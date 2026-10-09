/**
 * Backend module registry — the core's door into module code.
 *
 * Modules are self-registered: every modules/<id>/backend.ts with a
 * matching-shape default export is a registration, discovered by a directory
 * scan at load (the backend runs unbundled, so this is a runtime readdir, not
 * the statically resolvable glob the bundled frontend registry uses). Adding a
 * module needs no edit to this file. Malformed registrations are rejected at
 * load with the module id in the message (a broken module never boots silently).
 *
 * Each module's `services.capabilities` record is wired into the capability
 * bus at load, so the core reaches module behaviour through
 * requireCapability("stream.encoder") and never names a module id.
 */
import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { logEvent } from "./eventlog";
import { pushModuleEvent } from "./push";
import { MODULE_CONFIG_KEYS, type PersistentState, state } from "./state";
import { buildModuleCore, type ModuleStatus } from "./module-core";
import { provideCapability } from "./capabilities";
import type { ServerDashboard } from "../public/types";

const MODULES_DIR = fileURLToPath(new URL("../modules", import.meta.url));

/** Channels a dashboard hub keeps attached (lowercased names). */
type ChannelSpecs = Set<string>;

/** A module's registration as the registry sees it (structural, loose on purpose). */
interface ModuleRegistration {
	kind: string;
	id: string;
	title: string;
	configSchema: unknown;
	secretFields: string[];
	start(ctx: { config: Record<string, unknown>; emit: (e: string, d: unknown) => void; log: (s: string, m: string) => void; core: unknown }): Promise<void>;
	stop(): Promise<void>;
	methods: readonly string[];
	events: readonly string[];
	/** ids of modules this one must have started first (topological order). */
	dependencies?: readonly string[];
	dispatch(method: string, params: Record<string, unknown>): Promise<unknown>;
	status?: () => Promise<Record<string, unknown>>;
	services?: { capabilities?: Record<string, unknown> };
	/** Dashboard-hub services (channel widget modules only). */
	hub?: {
		widgetType: string;
		snapshotKey: string;
		configFields: readonly string[];
		channelSpec: (config: Record<string, string> | undefined) => string | null;
		create: (publish: (msg: string) => void) => ChannelHub;
		enabled?(config: Record<string, unknown> | undefined): boolean;
	};
}

interface ChannelHub {
	sync(specs: ChannelSpecs): void;
	startedChannels(): string[];
	snapshot(): Record<string, unknown>;
	destroy(): void;
}

/**
 * Deterministic start order: topological over declared `dependencies` (a module
 * comes after the modules it depends on). Ties break by id, so the order is
 * stable and independent of readdir order. An unknown dependency id or a
 * dependency cycle throws at load. This replaces the old hard-coded
 * CANONICAL_ORDER list (which named module IDs in the core).
 */
function resolveOrder(mods: ModuleRegistration[]): ModuleRegistration[] {
	const byId = new Map(mods.map((m) => [m.id, m]));
	const order: ModuleRegistration[] = [];
	const done = new Set<string>();
	const onStack = new Set<string>();
	const visit = (mod: ModuleRegistration): void => {
		if (done.has(mod.id)) return;
		if (onStack.has(mod.id)) throw new Error(`module dependency cycle at ${mod.id}`);
		onStack.add(mod.id);
		for (const dep of mod.dependencies ?? []) {
			const target = byId.get(dep);
			if (!target) throw new Error(`module ${mod.id} depends on unknown module ${dep}`);
			visit(target);
		}
		onStack.delete(mod.id);
		done.add(mod.id);
		order.push(mod);
	};
	for (const mod of [...mods].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))) visit(mod);
	return order;
}

function validate(mod: unknown, file: string): asserts mod is ModuleRegistration {
	if (typeof mod !== "object" || mod === null) throw new Error(`module registration in ${file} is not an object`);
	const m = mod as Record<string, unknown>;
	const id = typeof m.id === "string" ? m.id : null;
	if (m.kind !== "device" && m.kind !== "widget") {
		throw new Error(`module ${id ?? file}: kind must be "device" or "widget"`);
	}
	if (!id || !m.title) throw new Error(`module registration in ${file} needs a string id and title`);
	if (m.kind === "device") {
		if (typeof m.configSchema !== "object" || m.configSchema === null) {
			throw new Error(`module ${id}: configSchema must be an object (a zod object declaration)`);
		}
		if (typeof m.start !== "function" || typeof m.stop !== "function") {
			throw new Error(`module ${id}: start/stop must be methods`);
		}
		if (!Array.isArray(m.methods) || !Array.isArray(m.events) || typeof m.dispatch !== "function") {
			throw new Error(`module ${id}: methods/events must be arrays and dispatch a method`);
		}
		if (m.dependencies !== undefined &&
			(!Array.isArray(m.dependencies) || (m.dependencies as unknown[]).some((d) => typeof d !== "string"))) {
			throw new Error(`module ${id}: dependencies must be a string array`);
		}
	}
}

const discovered = new Map<string, ModuleRegistration>();
// Self-registering discovery: every modules/<id>/backend.ts is a registration.
// The backend runs unbundled (bun server.ts), so this is a runtime directory
// scan anchored on import.meta.url — not the statically resolvable glob the
// bundled frontend registry uses. Adding a module needs no edit to this file.
for (const entry of readdirSync(MODULES_DIR).sort()) {
	const backendPath = join(MODULES_DIR, entry, "backend.ts");
	if (!existsSync(backendPath)) continue;
	const file = `modules/${entry}/backend.ts`;
	let ns: { default?: unknown };
	try {
		ns = (await import(backendPath)) as { default?: unknown };
	} catch (err) {
		throw new Error(`failed to load module backend ${file}: ${err instanceof Error ? err.message : String(err)}`);
	}
	const mod: unknown = ns.default;
	if (mod === undefined) throw new Error(`module backend ${file} has no default export`);
	try {
		validate(mod, file);
	} catch (err) {
		throw new Error(`rejecting module backend ${file}: ${err instanceof Error ? err.message : String(err)}`);
	}
	if (discovered.has(mod.id)) throw new Error(`duplicate module id ${mod.id}`);
	discovered.set(mod.id, mod);
}

/** Registry order: topological over dependencies (stable, id-tie-broken). */
export const ALL_MODULES: ModuleRegistration[] = resolveOrder([...discovered.values()]);

/** Wire every module's capability record into the bus (before core modules read them). */
for (const mod of ALL_MODULES) {
	const caps = mod.services?.capabilities;
	if (caps) for (const [name, impl] of Object.entries(caps)) provideCapability(name, impl);
}

/** The live core bag (one instance, handed to every module start). */
const core = buildModuleCore((id) => {
	const mod = ALL_MODULES.find((m) => m.id === id);
	return mod ? { id: mod.id, status: mod.status } : undefined;
});

/** The core's door to a module's persisted settings slice (config key mapping). */
const moduleConfig = (id: string): Record<string, unknown> => {
	const m = state.settings.modules as Record<string, Record<string, unknown>> | undefined;
	const key = MODULE_CONFIG_KEYS[id] ?? id;
	const slice = m?.[key];
	return slice ? { ...slice } : {};
};

/** Modules whose `start()` ran; only these get stopped (`stop()` assumes a bound `core`). */
const started = new Set<string>();

/** Start every registered, settings-enabled module. */
export async function startModules(): Promise<void> {
	for (const mod of ALL_MODULES) {
		if (mod.hub) continue; // widget hubs are wired by initWidgetHub, not started
		const cfg = moduleConfig(mod.id);
		if (cfg.enabled !== true) continue;
		await mod.start({
			config: cfg,
			core,
			emit: (event, data) => pushModuleEvent(event, data, mod.id),
			log: (section, message) => logEvent("info", section, message),
		});
		started.add(mod.id);
	}
}

/** Stop the modules that were started (skipping never-started ones whose `core` is unbound). */
export async function stopModules(): Promise<void> {
	for (const mod of ALL_MODULES) {
		if (mod.hub || !started.has(mod.id)) continue;
		started.delete(mod.id);
		await mod.stop();
	}
}

/** Restart one registered module (stop, then start when settings-enabled). */
export async function restartRegisteredModule(id: string): Promise<void> {
	const mod = ALL_MODULES.find((m) => m.id === id);
	if (!mod) return;
	started.delete(id);
	await mod.stop();
	if (moduleConfig(id).enabled === true) {
		started.add(id);
		await mod.start({
			config: moduleConfig(id),
			core,
			emit: (event, data) => pushModuleEvent(event, data, mod.id),
			log: (section, message) => logEvent("info", section, message),
		});
	}
}

/** Collect each module's status fragment (the keys never collide by design). */
export async function moduleStatuses(): Promise<Record<string, unknown>> {
	const out: Record<string, unknown> = {};
	for (const mod of ALL_MODULES) {
		if (mod.status) Object.assign(out, await mod.status());
	}
	return out;
}

/** METHOD_OWNER — every module-owned RPC method mapped to its module. */
const METHOD_OWNER: Record<string, string> = {};
for (const mod of ALL_MODULES) for (const method of (mod.methods ?? [])) METHOD_OWNER[method] = mod.id;
export const methodOwner = (method: string): string | undefined => METHOD_OWNER[method];

/** Dispatch an RPC method to the module that owns it. */
export function callModule(method: string, params: Record<string, unknown>): Promise<unknown> {
	const owner = methodOwner(method);
	const mod = owner ? ALL_MODULES.find((m) => m.id === owner) : undefined;
	if (!mod) return Promise.reject(new Error(`unknown method ${method}`));
	return mod.dispatch(method, params);
}

/** All registered modules (device + widget), for validation/status views. */
export const allModules = (): { id: string; title: string }[] => ALL_MODULES.map((m) => ({ id: m.id, title: m.title }));

export const moduleTitles = (): Record<string, string> =>
	Object.fromEntries(ALL_MODULES.map((m) => [m.id, m.title]));

/** A module's live status fragment by id (the core bag's moduleById). */
export function moduleStatus(mod: ModuleRegistration): ModuleStatus {
	return mod.status ?? (async () => ({}));
}

/** Expose the state bag's modules slice for core views (keeps one mapping). */
export const settingsModules = (): PersistentState["settings"]["modules"] | undefined => state.settings.modules;

// ---------------------------------------------------------------------------
// Dashboard widget hub (channel widgets — device-independent).
//
// One hub instance per widget type serves every widget of that type; the
// registries wire it generically from each widget module's `hub` field, so
// adding a widget type needs no core edits.
// ---------------------------------------------------------------------------

interface WidgetEntry {
	type: string;
	snapshotKey: string;
	configFields: readonly string[];
	spec: (config: Record<string, string> | undefined) => string | null;
	hub: ChannelHub | null;
}

const WIDGETS: WidgetEntry[] = ALL_MODULES.filter((m) => m.hub).map((m) => ({
	type: m.hub!.widgetType,
	snapshotKey: m.hub!.snapshotKey,
	configFields: m.hub!.configFields,
	spec: m.hub!.channelSpec,
	hub: null,
}));

/** Config parameter names per widget type (server validation + dashboard editor). */
export const widgetConfigFields = (type: string): readonly string[] => WIDGETS.find((w) => w.type === type)?.configFields ?? [];

/** Wire the channel widget backends to the dashboard websocket topic. */
export function initWidgetHub(publish: (msg: string) => void): void {
	for (const w of WIDGETS) {
		const mod = discovered.get(w.type) ?? ALL_MODULES.find((m) => m.hub?.widgetType === w.type);
		w.hub = mod?.hub ? mod.hub.create(publish) : null;
	}
}

/** Sync the widget backends with the dashboard configs (the dashboards write path). */
export function syncWidgetHub(dashboards: ServerDashboard[]): void {
	for (const w of WIDGETS) w.hub?.sync(widgetChannelSpecs(dashboards, w.type, w.spec));
}

/** Latest per-type samples for warm-starting a dashboard viewer. */
export function widgetHubSnapshot(): Record<string, unknown> {
	const out: Record<string, unknown> = {};
	for (const w of WIDGETS) out[w.snapshotKey] = w.hub?.snapshot() ?? {};
	return out;
}

/** Stop the widget hub (server shutdown). */
export function destroyWidgetHub(): void {
	for (const w of WIDGETS) {
		w.hub?.destroy();
		w.hub = null;
	}
}

/** Channels to keep attached, from one type's dashboard widgets. */
export function widgetChannelSpecs(
	dashboards: ServerDashboard[],
	type: string,
	spec: (config: Record<string, string> | undefined) => string | null,
): ChannelSpecs {
	const channels = new Set<string>();
	for (const dash of dashboards) {
		for (const w of dash.widgets) {
			if (w.type !== type) continue;
			const name = spec(w.config);
			if (name) channels.add(name);
		}
	}
	return channels;
}
