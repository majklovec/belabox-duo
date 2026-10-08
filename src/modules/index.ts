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
        "obs-controller": {
            enabled: obs.enabled,
            obsUrl: obs.obsUrl,
            obsPassword: obs.obsPassword ? { configured: true } : { configured: false },
            sceneEvents: obs.sceneEvents,
            switcherEnabled: obs.switcherEnabled,
            // No secrets in the switcher config: the whole slice goes to the client
            switcher: obs.switcher,
        },
    };
}
