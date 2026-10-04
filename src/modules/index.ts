/*
 * Module runner: starts/stops the kick-chat module according to
 * settings.modules, and exposes helpers for the API:
 *   - moduleEnabled / moduleAllowed gate the module-owned methods (409)
 *   - modulesView() is the secret-free module map put into the status
 *   - restartModule() re-applies a module after configure/enable changes
 * (obs-controller and kick-stats moved to modules/ and run through the
 * registry in modules/registry.backend.ts)
 */
import { startKickChat, stopKickChat } from "./kick-chat";
import {
    type ModulesState,
    KICK_CHAT_MODULE,
    state,
} from "../state";

const mods = (): ModulesState | undefined => state.settings.modules;

export const moduleEnabled = (id: string): boolean => {
    const m = mods();
    if (!m) return false;
    return (m as unknown as Record<string, { enabled: boolean }>)[id]?.enabled ?? false;
};

export function startModules(): void {
    if (moduleEnabled(KICK_CHAT_MODULE)) startKickChat();
}

export function stopModules(): void {
    stopKickChat();
}

/** Re-apply one module after a configure/enable/disable change. */
export function restartModule(id: string): void {
    switch (id) {
        case KICK_CHAT_MODULE:
            startKickChat();
            break;
    }
}

/** Apply a module's persisted configuration (secrets kept); caller saves state. */
export function configureModule(id: string, config: Record<string, unknown>): void {
    const m = mods();
    if (!m) return;
    switch (id) {
        case KICK_CHAT_MODULE: {
            if (typeof config.enabled === "boolean") m["kick-chat"].enabled = config.enabled;
            if (typeof config.channel === "string") m["kick-chat"].channel = config.channel;
            if (typeof config.token === "string") m["kick-chat"].token = config.token;
            restartModule(id);
            break;
        }
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
    const chat = m["kick-chat"];
    return {
        relay: m.relay,
        encoder: m.encoder,
        "obs-controller": {
            enabled: obs.enabled,
            obsUrl: obs.obsUrl,
            obsPassword: obs.obsPassword ? { configured: true } : { configured: false },
            sceneEvents: obs.sceneEvents,
        },
        "kick-stats": { enabled: m["kick-stats"].enabled, channel: m["kick-stats"].channel },
        "kick-chat": {
            enabled: chat.enabled,
            channel: chat.channel,
            token: chat.token ? { configured: true } : { configured: false },
        },
    };
}
