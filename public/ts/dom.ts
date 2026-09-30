/* Tiny helpers shared by all pages. Views are Mithril vnodes; this is what doesn't need to be. */
import m from "mithril";

/** Look up an element by id (mount point, the rare DOM escape hatch). */
export const byId = <T extends HTMLElement = HTMLElement>(id: string): T => {
	const el = document.getElementById(id);
	if (!el) throw new Error(`#${id} missing`);
	return el as T;
};

/** A renderable Mithril child: a vnode, text, a number, or nothing. */
export type Child = m.Vnode | string | number | null | undefined;

/** "12s ago" style relative time; "—" when unknown. */
export const since = (ts?: number) => {
	if (!ts) return "—";
	const s = Math.round((Date.now() - ts) / 1000);
	if (s < 60) return `${s}s ago`;
	if (s < 3600) return `${Math.floor(s / 60)}m ago`;
	return `${Math.floor(s / 3600)}h ${Math.floor((s % 3600) / 60)}m ago`;
};

export function formatBitrate(bytesPerSec: number): string {
	const kbps = (bytesPerSec * 8) / 1000;
	return kbps >= 1000 ? `${(kbps / 1000).toFixed(2)} Mbps` : `${Math.round(kbps)} kbps`;
}
