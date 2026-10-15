/*
 * Module helpers for the API: every real module now runs through the registry
 * in modules/registry.backend.ts; this file keeps the role/core-facing
 * helpers that are not module-specific:
 *   - moduleEnabled / methodAllowed gate the module-owned methods (409)
 *   - safeModules() is the secret-free module map put into the status
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

/** The persisted module map for the status; secret strings come back as `{configured}`. */
export function safeModules(): object {
    const m = mods();
    if (!m) return {};
    const mask = (cfg: Record<string, unknown>) =>
        Object.fromEntries(
            Object.entries(cfg).map(([k, v]) =>
                /password|token/i.test(k) && typeof v === "string" ? [k, { configured: v !== "" }] : [k, v],
            ),
        );
    return Object.fromEntries(
        Object.entries(m as unknown as Record<string, Record<string, unknown>>).map(([id, cfg]) => [id, mask(cfg)]),
    );
}
