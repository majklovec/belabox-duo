/*
 * chat widget — config parameters and feed options, shared by the backend
 * hub (spec computation, validation) and the frontend (editor form, merged
 * feed). Pure: this file must stay free of any package import (the frontend
 * bundle imports it; the providers in `providers/` carry the npm deps and
 * are backend-only).
 */
/** chat widget's configurable parameters (single source for the server
 * validation and the frontend editor): one channel per platform, then the
 * shared feed options. */
export const CHAT_CONFIG_FIELDS = [
	"youtube",
	"twitch",
	"tiktok",
	"kick",
	"history",
	{ name: "order", type: "select", options: ["top", "bottom"] },
] as const;
export const CHAT_PLATFORMS = ["youtube", "twitch", "tiktok", "kick"] as const;
/** Default visible history size — matches the backend rolling-history cap. */
export const DEFAULT_HISTORY_LINES = 500;
/** Where new messages enter the feed: "top" (the default, newest first) or
 * "bottom" (oldest first, new lines arrive at the bottom). */
export type ChatOrder = "top" | "bottom";

/**
 * A widget's visible-history size, validated from its config. Non-numeric,
 * non-positive or absurd values fall back to the default rather than crashing
 * the frontend (the value renders as-is there).
 */
export function historyLengthFromConfig(config: Record<string, string> | undefined): number {
	const value = (config?.["history"] ?? "").trim().replace(/^\D+|\s+$/g, "");
	if (!value) return DEFAULT_HISTORY_LINES;
	const n = parseInt(value, 10);
	if (!Number.isFinite(n) || n < 1 || n > 10_000) return DEFAULT_HISTORY_LINES;
	return n;
}

/**
 * A widget's new-message placement, validated from its config. Anything that
 * is not "bottom" falls back to "top" (the historic default, newest first).
 */
export function chatOrderFromConfig(config: Record<string, string> | undefined): ChatOrder {
	const value = (config?.["order"] ?? "").trim().toLowerCase();
	return value === "bottom" ? "bottom" : "top";
}

/** Normalize one platform channel value (lowercased, trimmed; "" when empty). */
const channelPart = (value: string | undefined): string => (value ?? "").trim().toLowerCase();

/** The channel for one platform from a widget's config ("" when the platform
 * channel is not filled). */
export function platformChannel(platform: (typeof CHAT_PLATFORMS)[number], config: Record<string, string> | undefined): string {
	return channelPart(config?.[platform]);
}

/** The hub specs from one widget's config: one `<platform>:<channel>` per
 * filled platform channel (empty platforms produce no spec, so the widget can
 * merge with other widgets that fill the same channel). */
export function chatSpecsFromConfig(config: Record<string, string> | undefined): (string | null)[] {
	return CHAT_PLATFORMS.map((platform) => {
		const name = platformChannel(platform, config);
		return name ? `${platform}:${name}` : null;
	});
}
