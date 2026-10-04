/*
 * Module runner: starts/stops the obs-controller, kick-stats and kick-chat
 * modules according to settings.modules, and exposes helpers for the API:
 *   - moduleEnabled / moduleAllowed gate the module-owned methods (409)
 *   - modulesView() is the secret-free module map put into the status
 *   - restartModule() re-applies a module after configure/enable changes
 */
import { kickChatConnected, startKickChat, stopKickChat } from "./kick-chat";
import { kickStatsLatest, startKickStats, stopKickStats } from "./kick-stats";
import { obsClientFor, restartObsModule, startObsModule, stopObsModule } from "./obs";
import {
    type ModulesState,
    type ObsModuleConfig,
    KICK_CHAT_MODULE,
    KICK_STATS_MODULE,
    OBS_MODULE,
    state,
} from "../state";

const mods = (): ModulesState | undefined => state.settings.modules;

export const moduleEnabled = (id: string): boolean => {
    const m = mods();
    if (!m) return false;
    return (m as unknown as Record<string, { enabled: boolean }>)[id]?.enabled ?? false;
};

export function startModules(): void {
    if (moduleEnabled(OBS_MODULE)) startObsModule();
    if (moduleEnabled(KICK_STATS_MODULE)) startKickStats();
    if (moduleEnabled(KICK_CHAT_MODULE)) startKickChat();
}

export function stopModules(): void {
    stopObsModule();
    stopKickStats();
    stopKickChat();
}

/** Re-apply one module after a configure/enable/disable change. */
export function restartModule(id: string): void {
    switch (id) {
        case OBS_MODULE:
            restartObsModule();
            break;
        case KICK_STATS_MODULE:
            startKickStats();   // stops itself first; a fresh channel is picked up
            break;
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
        case OBS_MODULE: {
            const obs = m["obs-controller"];
            if (typeof config.enabled === "boolean") obs.enabled = config.enabled;
            if (typeof config.obsUrl === "string") obs.obsUrl = config.obsUrl;
            if (typeof config.obsPassword === "string" && config.obsPassword !== undefined) obs.obsPassword = config.obsPassword;
            if (typeof config.sceneEvents === "boolean") obs.sceneEvents = config.sceneEvents;
            restartModule(id);
            break;
        }
        case KICK_STATS_MODULE: {
            if (typeof config.enabled === "boolean") m["kick-stats"].enabled = config.enabled;
            if (typeof config.channel === "string") m["kick-stats"].channel = config.channel;
            restartModule(id);
            break;
        }
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
    const obs: ObsModuleConfig = m["obs-controller"];
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

/** Per-module live state for status (obs identified flag, kick latest stats). */
export function moduleStatesView(): object {
    return {
        "obs-controller": obsClientFor()
            ? { connected: obsClientFor()?.connected ?? false, identified: obsClientFor()?.identified ?? false }
            : null,
        "kick-stats": kickStatsLatest(),
        "kick-chat": { connected: kickChatConnected() },
    };
}
