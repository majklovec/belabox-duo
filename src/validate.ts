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
export const ROLES = ["relay", "encoder", "combined"] as const;
export type Role = (typeof ROLES)[number];
export const isRole = (v: unknown): v is Role => (ROLES as readonly unknown[]).includes(v);

/** Encoder bitrate bounds (kbps). */
export const BITRATE_KBPS = { min: 300, max: 30_000 } as const;

export const DEFAULT_COLOR = "#3b82f6";
