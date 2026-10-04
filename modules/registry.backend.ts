/**
 * Backend module registry — the only module entry point the core may import.
 *
 * src/methods.ts, src/client.ts and src/routing.ts import exclusively from
 * here; they never import a concrete module. Modules are listed explicitly
 * (no glob / auto-discovery).
 *
 * Migration status (see TODO.md): each import below is uncommented as its
 * module moves into modules/<id>/.
 *
 * The registry also hosts the module-runtime helpers the device core used to
 * get from src/modules/: start/stop loops, the ctx factory (push.ts /
 * eventlog.ts / state.ts wiring) and status-fragment collection for
 * buildStatus().
 */
import { logEvent } from "../src/eventlog";
import { pushModuleEvent } from "../src/push";
import { state } from "../src/state";
import type { DeviceModule, ModuleContext } from "./types";
import { encoderModule, encoderServices } from "./encoder/backend";
import { srtlaModule, srtlaServices } from "./srtla/backend";
import { detectModems, modemNetworkIface, modemsModule } from "./modems/backend";
import { obsControllerModule, obsServices } from "./obs-controller/backend";
import { kickStatsModule, kickStatsServices } from "./kick-stats/backend";
// import { kickChatModule } from "./kick-chat/backend";

export const ALL_MODULES: DeviceModule[] = [encoderModule, srtlaModule, modemsModule, obsControllerModule, kickStatsModule];

/**
 * Encoder services consumed by the core (stream orchestration in stream.ts,
 * status build, shutdown in client.ts) — the registry is the door into the
 * encoder module.
 */
export { encoderServices };

/**
 * SRTLA services consumed by the core (stream orchestration in stream.ts,
 * autostart and shutdown in client.ts, status build, method dispatch).
 */
export { srtlaServices };

/**
 * OBS services consumed by the core — the obs.* method dispatch in methods.ts
 * sends requests to the module's client; `configure` receives the obs fields
 * of a modules.configure call.
 */
export { obsServices };

/**
 * Kick-stats services consumed by the core — `latest` serves the most recent
 * polled sample to kick.stats.get / kick.chat.get; `configure` applies the
 * kick-stats fields of a modules.configure call.
 */
export { kickStatsServices };

/** Module by id, or undefined. */
export const getModule = (id: string) => ALL_MODULES.find((m) => m.id === id);

/** All module ids, in registry order. */
export const moduleIds = (): string[] => ALL_MODULES.map((m) => m.id);

/**
 * Modem-lookup services consumed by core routing (interface enrichment). The
 * registry is the core's only door into module code, so module-specific
 * service functions the core needs are exposed here.
 */
export const modemServices = { detect: detectModems, modemIface: modemNetworkIface };

/**
 * Build the runtime context handed to start(): `config` is the module's
 * persisted settings slice, `emit` pushes a module-scoped event frame
 * (push.ts), `log` appends to the device log (eventlog.ts).
 */
export function makeCtx(mod: DeviceModule): ModuleContext {
	const m = state.settings.modules as Record<string, Record<string, unknown>> | undefined;
	return {
		config: m?.[mod.id] ? { ...m[mod.id] } : {},
		emit: (event, data) => pushModuleEvent(event, data, mod.id),
		log: (section, message) => logEvent("info", section, message),
	};
}

/**
 * Dispatch an RPC method to the module that owns it. `owner` is the module
 * id from the METHOD_OWNER map in methods.ts.
 */
export function callModule(owner: string, method: string, params: Record<string, unknown>): Promise<unknown> {
	const mod = getModule(owner);
	if (!mod) return Promise.reject(new Error(`unknown module ${owner}`));
	return mod.dispatch(method, params);
}

/** Start every registered, settings-enabled module. */
export async function startModules(): Promise<void> {
	for (const mod of ALL_MODULES) {
		if (!moduleSettingsEnabled(mod.id)) continue;
		await mod.start(makeCtx(mod));
	}
}

/** Stop every registered module. */
export async function stopModules(): Promise<void> {
	for (const mod of ALL_MODULES) await mod.stop();
}

/** Restart one registered module (stop, then start when settings-enabled). */
export async function restartRegisteredModule(id: string): Promise<void> {
	const mod = getModule(id);
	if (!mod) return;
	await mod.stop();
	if (moduleSettingsEnabled(id)) await mod.start(makeCtx(mod));
}

/**
 * Collect each module's status fragment for buildStatus(); the caller uses
 * the keys it needs (fragment keys never collide by design). Modules without
 * an `enabled` settings key (modems) still report — the role/role-based
 * gating stays with the caller (methods.ts).
 */
export async function moduleStatuses(): Promise<Record<string, unknown>> {
	const out: Record<string, unknown> = {};
	for (const mod of ALL_MODULES) {
		if (mod.status) Object.assign(out, await mod.status());
	}
	return out;
}

function moduleSettingsEnabled(id: string): boolean {
	const m = state.settings.modules as Record<string, { enabled?: boolean }> | undefined;
	return m?.[id]?.enabled ?? false;
}
