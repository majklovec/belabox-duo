/**
 * kick-stats widget — local wire/state types. The module is self-contained:
 * it declares the shapes it exchanges over the dashboard websocket and the
 * hub/manager contract it implements. The core reaches this module only
 * structurally (the registry validates the shape), so no type crosses a
 * module boundary.
 */

/** One viewer-count sample for the line chart (oldest first). */
export interface StatsSample {
	/** Poll time (epoch ms) */
	t: number;
	/** Viewers (0 when the channel is offline) */
	v: number;
}

/** Latest kick.stats sample (the server's Kick channel stats poll). */
export interface StatsLive {
	viewers?: number;
	followers?: number;
	isLive: boolean;
	title?: string;
	/** Current stream category name (e.g. "Just Chatting"). */
	category?: string;
	/** Current stream start time (epoch ms). */
	startTime?: number;
	/** Server-side timestamp of the poll */
	at: number;
	/** Recent viewer samples (oldest first), capped by the poller. */
	series?: StatsSample[];
}

/** One channel's live state fragment on the wire. */
export interface ChannelLive {
	stats?: StatsLive | null;
}

/** Channels to keep attached (lowercased names). */
export type ChannelSpecs = Set<string>;

/** Deliver a serialized event frame to subscribers. */
export type PublishFn = (msg: string) => void;

/** Serialize an event frame for the module websockets. */
export const eventFrame = (event: string, data: unknown): string => JSON.stringify({ type: "event", event, data });

/** Render context passed to a widget by the core: the live state of the widget's
 * own device (undefined for device-independent widgets). */
export interface WidgetContext {
	deviceLive?: Record<string, unknown> | null;
	device?: Record<string, unknown> | null;
}

/** Frontend descriptor the dashboard registry renders. The module owns its
 * live state (fed by `onFrame`); `body`/`badge` render from it plus, where
 * relevant, the widget's device state in `ctx`. */

/** A config parameter: a bare string (free text) or a `{name, type:"select",
 * options}` fixed-choice field rendered as a dropdown. */
export type WidgetConfigField =
	| string
	| { name: string; type: "select"; options: readonly string[] };

export interface ChannelWidgetModule<TWidget = unknown> {
	id: string;
	kind: "widget";
	/** Widget types this module composes; the core routes by this table. */
	widgetTypes: readonly string[];
	defaultSize: { w: number; h: number };
	/** Config parameter names this widget accepts, in editor form order. */
	configFields: readonly WidgetConfigField[];
	/** The widget's channel name from its config ("" when not configured). */
	channelOf(w: TWidget): string;
	/** Render the widget body from the module's live state. */
	body(w: TWidget, ctx: WidgetContext): unknown;
	/** Status badge shown next to the widget title in the card head. */
	badge(w: TWidget, ctx: WidgetContext): unknown;
	/** Fold one dashboard-websocket frame into the module's live state. */
	onFrame(event: string, data: unknown): void;
}
