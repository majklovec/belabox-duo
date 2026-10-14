/*
 * Module helpers for the API: every real module now runs through the registry
 * in modules/registry.backend.ts; this file keeps the role/core-facing
 * helpers that are not module-specific:
 *   - moduleEnabled / methodAllowed gate the module-owned methods (409)
 *   - modulesView() is the secret-free module map put into the status
 *   - configureModule() applies relay/encoder toggles (applied at role start)
 */
import { type ModulesState, state } from "../state";

const mods = (): ModulesState | undefined => state.settings.modules;

export const moduleEnabled = (id: string): boolean => {
    const m = mods();
    if (!m) return false;
    return (m as unknown as Record<string, { enabled: boolean }>)[id]?.enabled ?? false;
};

/** Apply a module's persisted configuration (secrets kept); caller saves state. */
export function configureModule(id: string, config: Record<string, unknown>): void {
    const m = mods();
    if (!m) return;
    switch (id) {
        case "relay":
        case "encoder": {
            if (typeof config.enabled === "boolean") m[id].enabled = config.enabled;
            // Subprocess wiring follows the process role and applies on restart
            break;
        }
    }
}

/** The module map for the status: secrets are replaced by `configured` flags. */
export function modulesView(): object {
    const m = mods();
    if (!m) return {};
    const obs = m["obs-controller"];
    return {
        relay: m.relay,
        encoder: m.encoder,
        modems: m.modems,
        "obs-controller": {
            enabled: obs.enabled,
            obsUrl: obs.obsUrl,
            obsPassword: obs.obsPassword ? { configured: true } : { configured: false },
            sceneEvents: obs.sceneEvents,
        },
        // No secrets in the switcher settings: the switcher rides on the obs
        // slice, so its view is synthesized from there (backfill guarantees the
        // fields exist).
        "low-bitrate-switcher": {
            enabled: obs.switcherEnabled !== false,
            obsSourceName: obs.obsSourceName ?? "",
            failBehaviour: obs.failBehaviour ?? "pause",
            autoSwitch: obs.autoSwitch ?? true,
            onlySwitchWhenStreaming: obs.onlySwitchWhenStreaming ?? false,
            instantlySwitchOnRecover: obs.instantlySwitchOnRecover ?? true,
            retryAttempts: obs.retryAttempts ?? 5,
            pollIntervalMs: obs.pollIntervalMs ?? 1000,
            triggers: obs.triggers ?? { low: 500, offline: 400, rtt: 1500 },
            scenes: obs.scenes ?? { normal: "", low: "", offline: "" },
            optionalScenes: obs.optionalScenes ?? { starting: "", ending: "", privacy: "" },
            logToFile: obs.logToFile ?? true,
        },
    };
}
