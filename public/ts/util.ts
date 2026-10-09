/* Plain helpers shared by all pages (formatting, parsing, page bootstrap). Views are JSX
 * (Bun's transform with the `m` pragma) built with components/ui; this is what doesn't
 * need to be. Also the single place the UI styles enter the bundle: Panda's generated
 * CSS first (preflight, tokens, recipes), then the small theme foundations file so the
 * app's rules win the cascade; Bun replaces the HTML <link> with the combined asset. */
import m from "mithril";
import { i18nReady, t } from "./i18n";
import "../css/panda/styles.css";
import "../css/style.css";

/** A renderable Mithril child: a vnode, text, a number, or nothing. */
export type Child = m.Vnode | string | number | false | null | undefined;

/** Mount a page component into #app, setting the document title first. */
/** Wait for the PO catalogs to load, then mount. Title is a thunk so it
 * translates with the loaded catalogs (t() returns the raw key before ready). */
/** A component for `m.mount`: `m.Component` objects and plain function
 * (JSX) components — mithril's renderer handles both. */
export type Mountable = m.Component | ((v?: m.Vnode) => m.Vnode | m.Children);

export async function mountPage(title: () => string, component: Mountable): Promise<void> {
	await i18nReady;
	document.title = title();
	// Always-dark UI: panda-ui-mithril's recipes branch on [data-theme="dark"].
	document.documentElement.setAttribute("data-theme", "dark");
	m.mount(document.getElementById("app")!, component as m.Component);
}

/** Tint the whole UI with the device's configured color (theme.css derives all
 * --dev-* vars from this single seed). */
export const setHeaderColor = (color: string): void =>
	document.documentElement.style.setProperty("--dev-accent", color);

/** HTML `pattern` for hostnames (src/validate HOSTNAME_RE). Browsers compile `pattern` with the
 * `v` flag, where a literal "-" in a character class must be escaped. */
export const HOSTNAME_PATTERN = "[A-Za-z0-9][A-Za-z0-9.\\-]{0,62}";

/** Form value → number; "" means "not set". */
export const optionalNumber = (v: string): number | undefined => (v === "" ? undefined : Number(v));

/** Form value → number; "" counts as 0. */
export const toNumber = (v: string): number => (v === "" ? 0 : Number(v));

/** Whether a form value is a number within [min, max]. */
export const inRange = (v: string, min: number, max: number): boolean => {
	const n = Number(v);
	return v !== "" && n >= min && n <= max;
};

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
	return kbps >= 1000 ? `${(kbps / 1000).toFixed(2)} ${t("dev.unit_mbps")}` : `${Math.round(kbps)} ${t("dev.unit_kbps")}`;
}

/** Link speed in Mb/s → "100 Mb/s" / "2.5 Gb/s". */
export const formatSpeed = (mbps: number): string =>
	mbps >= 1000 ? t("dev.unit_gbs", mbps / 1000) : t("dev.unit_mbs", mbps);
