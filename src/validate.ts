/*
 * Shared input validation: format rules and value ranges used on the wire API and
 * mirrored by the web UI (setup wizard, device page) so both accept the same values.
 * Dependency-free so the browser bundles can import it.
 */

export const HOSTNAME_RE = /^[A-Za-z0-9][A-Za-z0-9.-]{0,62}$/;
export const COLOR_RE = /^#[0-9a-fA-F]{6}$/;
export const REPO_RE = /^[\w.-]+\/[\w.-]+$/;
export const REMOTE_URL_RE = /^wss?:\/\//;

/** Device types: relay bonds SRT out via srtla_send, encoder runs belacoder / ceracoder,
 *  combined does both on one box. */
export const ROLES = ["relay", "encoder", "combined", "obs", "custom"] as const;
export type Role = (typeof ROLES)[number];

/**
 * Module IDs the role presets pre-select in a fresh device's default dashboard.
 * "obs" exposes the OBS controls; "custom" starts with everything off so the
 * operator assembles the dashboard freely.
 */
export const modulesForRole = (role: Role): string[] => {
	switch (role) {
		case "obs":
			return ["obs-controller"];
		case "custom":
			return [];
		case "combined":
			return ["relay", "encoder"];
		default:
			return [role];
	}
};
export const isRole = (v: unknown): v is Role => (ROLES as readonly unknown[]).includes(v);

/** Encoder bitrate bounds (kbps). */
// Single source: modules/types.ts (shared type contract of the module system).
export { BITRATE_KBPS } from "../modules/types";

export const DEFAULT_COLOR = "#3b82f6";
