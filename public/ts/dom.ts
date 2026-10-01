/* Tiny helpers shared by all pages. Views are Mithril vnodes; this is what doesn't need to be. */
import m from "mithril";
import { t } from "./i18n";

/** Look up an element by id (mount point, the rare DOM escape hatch). */
export const byId = <T extends HTMLElement = HTMLElement>(id: string): T => {
	const el = document.getElementById(id);
	if (!el) throw new Error(`#${id} missing`);
	return el as T;
};

/** A renderable Mithril child: a vnode, text, a number, or nothing. */
export type Child = m.Vnode | string | number | null | undefined;

/** "12s ago" style relative time in the current UI language; "—" when unknown. */
export const since = (ts?: number) => {
	if (!ts) return "—";
	const s = Math.round((Date.now() - ts) / 1000);
	if (s < 60) return t("time.s_ago", s);
	if (s < 3600) return t("time.m_ago", Math.floor(s / 60));
	return `${t("time.h_ago", Math.floor(s / 3600))} ${t("time.m_ago", Math.floor((s % 3600) / 60))}`;
};

export function formatBitrate(bytesPerSec: number): string {
	const kbps = (bytesPerSec * 8) / 1000;
	return kbps >= 1000 ? `${(kbps / 1000).toFixed(2)} Mbps` : `${Math.round(kbps)} kbps`;
}
