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
export const WIDGET_MODULE_IDS = ["kick-stats", "kick-chat"] as const;
export type WidgetModuleId = (typeof WIDGET_MODULE_IDS)[number];

/** channel (lowercased) -> auth token ("" when unauthenticated). */
export type ChannelSpecs = Map<string, string>;

/** Deliver a serialized event frame ({type:"event", event, data}) to subscribers. */
export type PublishFn = (msg: string) => void;

/**
 * One widget module backend state manager. `sync` starts channels not yet
 * attached, re-auths on token change, stops removed channels.
 */
export interface ChannelHub<TSnapshot = Record<string, unknown>> {
	/** channel (lowercased) -> config. */
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
 */
export interface ChannelWidgetModule<TWidget = unknown> {
	id: string;
	/** Config fields shown by the inline editor (form order). */
	configFields: Array<"channel" | "token">;
	/** Render the widget body; `live` is the channel's live state fragment. */
	body(w: TWidget, live: ChannelLive): unknown;
}
