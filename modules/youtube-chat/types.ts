/**
 * youtube-chat widget — local wire/state types. The module is self-contained:
 * it declares the shapes it exchanges over the dashboard websocket and the
 * hub/manager contract it implements. The core reaches this module only
 * structurally (the registry validates the shape), so no type crosses a
 * module boundary.
 */

/** One chat message (platform message id used for deduplication). */
export interface ChatLive {
	id: string | number;
	username?: string;
	/** The sender's identity color (hex), for username display. */
	color?: string;
	text?: string;
	type?: string;
	ts?: number;
}

/** One channel's live state fragment on the wire. */
export interface ChannelLive {
	chat?: ChatLive[];
	/** the hub's websocket for this channel was open */
	connected?: boolean;
}

/** Channels to keep attached (lowercased names). */
export type ChannelSpecs = Set<string>;

/** Deliver a serialized event frame to subscribers. */
export type PublishFn = (msg: string) => void;

/** Serialize an event frame for the module websockets. */
export const eventFrame = (event: string, data: unknown): string => JSON.stringify({ type: "event", event, data });

/** Frontend descriptor the dashboard registry renders. */
export interface ChannelWidgetModule<TWidget = unknown, TLive = ChannelLive> {
	id: string;
	kind: "widget";
	/** Config parameter names this widget accepts, in editor form order. */
	configFields: readonly string[];
	/** The widget's channel name from its config ("" when not configured). */
	channelOf(w: TWidget): string;
	/** Render the widget body; `live` is the channel's live state fragment. */
	body(w: TWidget, live: TLive): unknown;
	/** Status badge shown next to the widget title in the card head. */
	badge(w: TWidget, live: TLive): unknown;
}
