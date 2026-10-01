/* Shared building blocks (header, cards, badges, definition lists) for the Mithril views.
 * Views are plain `m()` trees driven by per-page state; these helpers keep the markup
 * consistent between pages. */
import m from "mithril";
import { LanguageSelect } from "../i18n";
import type { Child } from "../dom";

/** <header> + <main> page skeleton. The header always carries the language selector on
 * its right edge, followed by the page's own `headerRight` actions. */
export const Page: m.Component<{ title: m.Children; headerRight?: m.Children }> = {
	view: (v) => [
		m(
			"header",
			null,
			m("h1", v.attrs.title),
			m("span.actions", LanguageSelect, v.attrs.headerRight),
		),
		m("main", v.children),
	],
};

export interface CardProps {
	/** Bare <h2> title. Use `headActions` for the title-plus-actions row. */
	title?: Child;
	/** Actions on the right of the title row (.card-head). */
	headActions?: m.Children;
	class?: string;
	id?: string;
}

export const Card: m.Component<CardProps> = {
	view: (v) => {
		const a = v.attrs;
		const head =
			a.title === undefined
				? null
				: a.headActions !== undefined
					? m("div.card-head", null, m("h2", a.title), m("div.actions", a.headActions))
					: m("h2", a.title);
		return m("section.card", { class: a.class, id: a.id }, head, v.children);
	},
};

export const badge = (text: string, kind: "on" | "off" | "warn" | "" = "") => m("span", { class: `badge ${kind}`.trim() }, text);

/** <dl> of dt/dd rows; empty values render "—". */
export function definitionList(rows: [string, Child][]): m.Vnode {
	return m("dl", rows.flatMap(([k, v]) => [m("dt", k), m("dd", v ?? "—")]));
}

/** A <label> with a caption above its control; extra attrs (`class`, `hidden`, …) pass through. */
export function field(label: Child, control: m.Vnode, extra: m.Attributes = {}): m.Vnode {
	return m("label", extra, label, control);
}

/** A checkbox (or radios) with a caption beside it. */
export function checkField(label: Child, control: m.Vnode, extra: m.Attributes = {}): m.Vnode {
	return m("label", { ...extra, class: extra.class ? `${extra.class} check` : "check" }, label, control);
}

export type { Child };
