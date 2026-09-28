/* Tiny DOM helpers shared by the relay UI and the control server device list. */
export type Child = Node | string | number | null | undefined | false;

export const byId = <T extends HTMLElement = HTMLElement>(id: string): T => {
	const el = document.getElementById(id);
	if (!el) throw new Error(`#${id} missing`);
	return el as T;
};

/** Create an element; text children are inserted as text (never as HTML). */
export function h<K extends keyof HTMLElementTagNameMap>(
	tag: K,
	props: Partial<HTMLElementTagNameMap[K]> & { className?: string } = {},
	...children: Child[]
): HTMLElementTagNameMap[K] {
	const el = Object.assign(document.createElement(tag), props);
	for (const c of children) {
		if (c === null || c === undefined || c === false) continue;
		el.append(c instanceof Node ? c : String(c));
	}
	return el;
}

export const badge = (text: string, kind: "on" | "off" | "warn" | "" = "") =>
	h("span", { className: `badge ${kind}` }, text);

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
