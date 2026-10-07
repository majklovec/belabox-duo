/**
 * Widget channel modules — device-independent dashboard widgets (kick-stats,
 * kick-chat). Unlike device modules these have no device RPC: the dashboards
 * API (src/dashboards.ts) owns their hub lifecycle, one backend instance serves
 * every widget of the type, and the browser renders straight from the
 * `kick.snapshot` / per-push frames on the dashboard websocket.
 *
 * The registries wire them together: registry.backend.ts owns the hub
 * instances, registry.frontend.ts owns the rendered widget bodies.
 *
 * This file must stay dependency-free (type declarations only) so both the
 * registries and `public/types.ts` can import from it.
 */
import type { ChannelLive } from "./types";
export type { ChannelLive };

/** Widget types owned by a channel widget module (device-independent widgets). */
export const WIDGET_MODULE_IDS = ["kick-stats", "kick-chat", "tiktok-chat", "twitch-chat", "youtube-chat"] as const;
export type WidgetModuleId = (typeof WIDGET_MODULE_IDS)[number];

/** Channels to keep attached (lowercased names). */
export type ChannelSpecs = Set<string>;

/** Deliver a serialized event frame ({type:"event", event, data}) to subscribers. */
export type PublishFn = (msg: string) => void;

/**
 * One widget module backend state manager. `sync` starts channels not yet
 * attached and stops removed ones.
 */
export interface ChannelHub<TSnapshot = Record<string, unknown>> {
	/** channels to keep attached (lowercased names). */
	sync(specs: ChannelSpecs): void;
	startedChannels(): string[];
	/** Current per-channel state for the `kick.snapshot` handshake. */
	snapshot(): TSnapshot;
	destroy(): void;
}

/**
 * Frontend descriptor of one widget module — the dashboard renders the widget
 * body from the shared `kickLive` map, no per-widget transport state.
 * TWidget is the dashboard widget row type; TLive the module's fragment of the
 * channel live state (stats / chat messages) the body renders.
 *
 * Parameter names live only here + in the module backend — the core (server
 * validation, dashboard editor, shared types) handles the generic `config`
 * record and never names its fields.
 */
export interface ChannelWidgetModule<TWidget = unknown> {
	id: string;
	/** Config parameter names this widget accepts, in editor form order. */
	configFields: readonly string[];
	/** The widget's channel name from its config ("" when not configured). */
	channelOf(w: TWidget): string;
	/** Render the widget body; `live` is the channel's live state fragment. */
	body(w: TWidget, live: ChannelLive): unknown;
	/** Status badge shown next to the widget title in the card head. */
	badge(w: TWidget, live: ChannelLive): unknown;
}
