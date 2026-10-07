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

export const ALL_MODULES: DeviceModule[] = [encoderModule, srtlaModule, modemsModule, obsControllerModule];

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
// ---------------------------------------------------------------------------
// Dashboard widget hub (kick channel widgets — device-independent).
//
// Not a device module: one hub instance per widget type serves every widget
// of that type across all dashboards, and its events publish straight to the
// dashboard websocket topic. Exposed via the registry so the core never
// imports module internals (core-imports-registered-modules-only rule).
// ---------------------------------------------------------------------------

import { ChatChannelManager, chatSpecFromConfig, KICK_CHAT_CONFIG_FIELDS, type ChatSnapshot } from "./kick-chat/backend";
import { StatsChannelManager, statsSpecFromConfig, KICK_STATS_CONFIG_FIELDS, type StatsSnapshot } from "./kick-stats/backend";
import {
	ChatChannelManager as TiktokChatChannelManager,
	tiktokChatSpecFromConfig,
	TIKTOK_CHAT_CONFIG_FIELDS,
	type ChatSnapshot as TiktokChatSnapshot,
} from "./tiktok-chat/backend";
import {
	ChatChannelManager as TwitchChatChannelManager,
	twitchChatSpecFromConfig,
	TWITCH_CHAT_CONFIG_FIELDS,
	type ChatSnapshot as TwitchChatSnapshot,
} from "./twitch-chat/backend";
import {
	ChatChannelManager as YoutubeChatChannelManager,
	youtubeChatSpecFromConfig,
	YOUTUBE_CHAT_CONFIG_FIELDS,
	type ChatSnapshot as YoutubeChatSnapshot,
} from "./youtube-chat/backend";
import type { ChannelSpecs } from "./widgets";
import type { ServerDashboard } from "../public/types";

/** Config parameter names per widget type — declared by the modules, looked up
 * generically by the core (server validation + dashboard editor). */
const WIDGET_CONFIG_FIELDS: Record<string, readonly string[]> = {
	"kick-stats": KICK_STATS_CONFIG_FIELDS,
	"kick-chat": KICK_CHAT_CONFIG_FIELDS,
	"tiktok-chat": TIKTOK_CHAT_CONFIG_FIELDS,
	"twitch-chat": TWITCH_CHAT_CONFIG_FIELDS,
	"youtube-chat": YOUTUBE_CHAT_CONFIG_FIELDS,
};

export const widgetConfigFields = (type: string): readonly string[] => WIDGET_CONFIG_FIELDS[type] ?? [];

/** Per-channel stats + chat fragments merged for the hub snapshot. */
export interface WidgetHubSnapshot {
	stats: StatsSnapshot;
	chat: ChatSnapshot;
	tiktokChat: TiktokChatSnapshot;
	twitchChat: TwitchChatSnapshot;
	youtubeChat: YoutubeChatSnapshot;
}

/** The widget managers — wired once by initWidgetHub(); no-ops before. */
let widgetStats: StatsChannelManager | null = null;
let widgetChat: ChatChannelManager | null = null;
let widgetTiktokChat: TiktokChatChannelManager | null = null;
let widgetTwitchChat: TwitchChatChannelManager | null = null;
let widgetYoutubeChat: YoutubeChatChannelManager | null = null;

/** Wire the channel widget backends to the dashboard websocket topic. */
export function initWidgetHub(publish: (msg: string) => void): void {
	widgetStats = new StatsChannelManager(publish);
	widgetChat = new ChatChannelManager(publish);
	widgetTiktokChat = new TiktokChatChannelManager(publish);
	widgetTwitchChat = new TwitchChatChannelManager(publish);
	widgetYoutubeChat = new YoutubeChatChannelManager(publish);
}

/** Sync the widget backends with the dashboard configs (dashboards write path).
 * Each backend follows only the widgets of its own type: a kick-stats poller
 * (or kick-chat connection) is not started for a channel that only the other
 * widget type uses. */
export function syncWidgetHub(dashboards: ServerDashboard[]): void {
	if (!widgetStats || !widgetChat || !widgetTiktokChat || !widgetTwitchChat || !widgetYoutubeChat) return;
	widgetStats.sync(widgetChannelSpecs(dashboards, "kick-stats", statsSpecFromConfig));
	widgetChat.sync(widgetChannelSpecs(dashboards, "kick-chat", chatSpecFromConfig));
	widgetTiktokChat.sync(widgetChannelSpecs(dashboards, "tiktok-chat", tiktokChatSpecFromConfig));
	widgetTwitchChat.sync(widgetChannelSpecs(dashboards, "twitch-chat", twitchChatSpecFromConfig));
	widgetYoutubeChat.sync(widgetChannelSpecs(dashboards, "youtube-chat", youtubeChatSpecFromConfig));
}

/** Latest stats samples + chat history for warm-starting a dashboard viewer. */
export function widgetHubSnapshot(): WidgetHubSnapshot {
	return {
		stats: widgetStats?.snapshot() ?? {},
		chat: widgetChat?.snapshot() ?? {},
		tiktokChat: widgetTiktokChat?.snapshot() ?? {},
		twitchChat: widgetTwitchChat?.snapshot() ?? {},
		youtubeChat: widgetYoutubeChat?.snapshot() ?? {},
	};
}

/** Stop the widget hub (server shutdown). */
export function destroyWidgetHub(): void {
	widgetStats?.destroy();
	widgetChat?.destroy();
	widgetTiktokChat?.destroy();
	widgetTwitchChat?.destroy();
	widgetYoutubeChat?.destroy();
	widgetStats = null;
	widgetChat = null;
	widgetTiktokChat = null;
	widgetTwitchChat = null;
	widgetYoutubeChat = null;
}

/** Channels to keep attached, from one type's dashboard widgets.
 * `specFromConfig` is the type's module builder, so no config parameter name
 * is known to the core here. */
export function widgetChannelSpecs(
	dashboards: ServerDashboard[],
	type: string,
	specFromConfig: (config: Record<string, string> | undefined) => string | null,
): ChannelSpecs {
	const channels = new Set<string>();
	for (const dash of dashboards) {
		for (const w of dash.widgets) {
			if (w.type !== type) continue;
			const name = specFromConfig(w.config);
			if (name) channels.add(name);
		}
	}
	return channels;
}
