/*
 * Shared input validation: format rules used on the wire API and mirrored by
 * the setup wizard so both reject exactly the same values.
 */

export const HOSTNAME_RE = /^[A-Za-z0-9][A-Za-z0-9.-]{0,62}$/;
export const COLOR_RE = /^#[0-9a-fA-F]{6}$/;
export const REPO_RE = /^[\w.-]+\/[\w.-]+$/;
export const REMOTE_URL_RE = /^wss?:\/\//;
export const PORT = { min: 1024, max: 65535 };

export function isPort(port: number): boolean {
    return Number.isInteger(port) && port >= PORT.min && port <= PORT.max;
}
