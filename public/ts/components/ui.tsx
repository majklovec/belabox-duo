/* Shared building blocks (header, cards, badges, definition lists, bound form controls)
 * for Mithril JSX views. These helpers keep markup consistent between pages. */
import m from "mithril";
import type { EncoderState, Role, SrtlaState } from "../../types";
import { LanguageSelect, t } from "../i18n";
import type { MithrilJSXComponent } from "../jsx";
import type { Child } from "../util";

export type { Child };

/** <header> + <main> page skeleton. The header carries the optional main menu, then the
 * language selector and the page's own `headerRight` actions on its right edge. */
export const Page = {
	view: (v) => [
		<header>
			<h1>{v.attrs.title}</h1>
			{[
				v.attrs.nav !== undefined ? <nav class={"main-nav"}>{v.attrs.nav}</nav> : null,
				<span class={"actions"}>
					<LanguageSelect />
					{v.attrs.headerRight}
				</span>,
			]}
		</header>,
		<main>{v.children}</main>,
	],
} as MithrilJSXComponent<{ title: m.Children; nav?: m.Children; headerRight?: m.Children }>;

export const TitleWithBack = {
	view: ({ attrs: { href, backLabel }, children }) => [
		href !== undefined ? (
			<a class={"icon-link page-back"} href={href} title={backLabel} aria-label={backLabel}>
				<svg
					width={16}
					height={16}
					viewBox={"0 0 16 16"}
					fill={"none"}
					stroke={"currentColor"}
					stroke-width={1.75}
					stroke-linecap={"round"}
					stroke-linejoin={"round"}
					aria-hidden={"true"}
				>
					<path d={"M10 12L6 8l4-4"} />
				</svg>
			</a>
		) : null,
		" ",
		children,
	],
} as MithrilJSXComponent<{ href?: string; backLabel: string }>;

/** Main menu of the control server: the device list and the dashboards page. */
export const serverNav = (active: "devices" | "dashboards"): m.Vnode => (
	<span>
		{[
			<a
				href={"/"}
				class={active === "devices" ? "nav-link active" : "nav-link"}
				aria-current={active === "devices" ? "page" : undefined}
			>
				{t("mgmt.devices")}
			</a>,
			<a
				href={"/dashboards/"}
				class={active === "dashboards" ? "nav-link active" : "nav-link"}
				aria-current={active === "dashboards" ? "page" : undefined}
			>
				{t("dash.title")}
			</a>,
		]}
	</span>
);

export interface CardProps {
	/** Bare <h2> title. Use `headActions` for the title-plus-actions row. */
	title?: Child;
	/** Actions on the right of the title row (.card-head). */
	headActions?: m.Children;
	/** Extra class(es) on the <section.card> root (module scoping, e.g. `mod-modems`). */
	class?: string;
}

export const Card = {
	view: ({ attrs: { title, headActions, class: extra }, children }) => (
		<section class={extra === undefined ? "card" : `card ${extra}`}>
			{[
				title === undefined ? null : headActions === undefined ? (
					<h2>{title}</h2>
				) : (
					<div class={"card-head"}>
						<h2>{title}</h2>
						<div class={"actions"}>{headActions}</div>
					</div>
				),
				children, // nested arrays are flattened by mithril
			]}
		</section>
	),
} as MithrilJSXComponent<CardProps>;

export type BadgeKind = "on" | "off" | "warn" | "";

export const badge = (text: string, kind: BadgeKind = "") => <span class={`badge ${kind}`.trim()}>{text}</span>;

/** "connected" / "disconnected" header badge. */
export const connectionBadge = (connected: boolean) =>
	connected ? badge(t("dev.connected"), "on") : badge(t("dev.disconnected"), "off");

/** Encoder state badge when it is not simply streaming: stopped, srtla_send down (combined), restarting. */
export function encoderIssueBadge(
	role: Role | undefined,
	e: EncoderState,
	srtla: SrtlaState | undefined,
): m.Vnode | null {
	if (!e.running) return badge(t("dev.badge.stopped"), "off");
	if (role === "combined" && !srtla?.running) return badge(t("dev.badge.srtla_send_down"), "warn");
	if (!e.pid && e.restarts) return badge(t("dev.badge.restarting"), "warn");
	return null;
}

/** <dl> of dt/dd rows; empty values render "—". */
export function definitionList(rows: [string, Child][]): m.Vnode {
	return <dl>{rows.flatMap(([k, v]) => [<dt>{k}</dt>, <dd>{v ?? "—"}</dd>])}</dl>;
}

/** A <table> of th/td rows (dashboard widget bodies share this shape). */
export function widgetTable(rows: [string, Child][]): m.Vnode {
	return (
		<table class={"dash-table"}>
			<tbody>
				{rows.map(([label, value], i) => (
					<tr key={i}>
						<th>{label}</th>
						<td>{value}</td>
					</tr>
				))}
			</tbody>
		</table>
	);
}

/** A <label> with a caption above its control; extra attrs (`class`, `hidden`, …) pass through. */
export function field(label: Child, control: m.Children, extra: m.Attributes = {}): m.Vnode {
	return (
		<label {...extra}>
			{label}
			{control}
		</label>
	);
}

/** A checkbox (or radios) with its caption after it. */
export function checkField(label: Child, control: m.Children, extra: m.Attributes = {}): m.Vnode {
	return (
		<label {...extra} class={extra.class ? `${extra.class} check` : "check"}>
			{control}
			{label}
		</label>
	);
}

/** <button type="button">; pass `type: "submit"` for a form's default action. */
export const button = (label: Child, attrs: m.Attributes = {}) => (
	<button type={"button"} {...attrs}>
		{label}
	</button>
);

/** <div.actions> row of buttons. */
export const actions = (...children: m.Children[]) => <div class={"actions"}>{children}</div>;

/** Line break inside a flex-wrapped form. */
export const brk = () => <div class={"break"} />;

/** Titled full-width group of related form fields (<fieldset> + <legend>). */
export const fieldGroup = (legend: Child, ...children: m.Children[]) => (
	<fieldset class={"group"}>
		<legend>{legend}</legend>
		{children}
	</fieldset>
);

/** <option>s from [value, label] pairs. */
export const options = (pairs: readonly (readonly [string, string])[]): m.Vnode[] =>
	pairs.map(([value, label]) => (
		<option key={value} value={value}>
			{label}
		</option>
	));

export const audioCodecOptions = () =>
	options([
		["aac", "AAC"],
		["opus", "Opus"],
	]);

/** srtla_send scheduler modes. */
export const schedulerOptions = () =>
	options([
		["enhanced", t("dev.scheduler_enhanced")],
		["classic", t("dev.scheduler_classic")],
	]);

/** <form> whose submit runs `onSubmit` instead of navigating. */
export const form = (attrs: m.Attributes & { onSubmit?: () => void }, ...children: m.Children[]) => {
	const { onSubmit, ...rest } = attrs;
	return (
		<form
			{...rest}
			onsubmit={(e: Event) => {
				e.preventDefault();
				onSubmit?.();
			}}
		>
			{children}
		</form>
	);
};

// -- Controls two-way bound to a property of a state object ------------------------
/** Keys of `T` whose values are `V`. */
export type KeysOf<T, V> = { [K in keyof T]-?: T[K] extends V ? K : never }[keyof T] & string;

/** <input> bound to the string `target[key]`; `name` defaults to the key. */
export function input<T extends object>(
	target: T,
	key: KeysOf<T, string>,
	attrs: m.Attributes = {},
	onChange?: (value: string) => void,
): m.Vnode {
	return (
		<input
			name={key}
			{...attrs}
			value={target[key]}
			oninput={(e: Event) => {
				const value = (e.target as HTMLInputElement).value;
				(target as Record<string, unknown>)[key] = value;
				onChange?.(value);
			}}
		/>
	);
}

/** <select> bound to the string `target[key]`. */
export function select<T extends object>(
	target: T,
	key: KeysOf<T, string>,
	children: m.Children,
	attrs: m.Attributes = {},
	onChange?: (value: string) => void,
): m.Vnode {
	return (
		<select
			name={key}
			{...attrs}
			value={target[key]}
			onchange={(e: Event) => {
				const value = (e.target as HTMLSelectElement).value;
				(target as Record<string, unknown>)[key] = value;
				onChange?.(value);
			}}
		>
			{children}
		</select>
	);
}

/** Checkbox bound to the boolean `target[key]`. */
export function checkbox<T extends object>(
	target: T,
	key: KeysOf<T, boolean>,
	attrs: m.Attributes = {},
	onChange?: (checked: boolean) => void,
): m.Vnode {
	return (
		<input
			type={"checkbox"}
			name={key}
			{...attrs}
			checked={target[key]}
			onchange={(e: Event) => {
				const checked = (e.target as HTMLInputElement).checked;
				(target as Record<string, unknown>)[key] = checked;
				onChange?.(checked);
			}}
		/>
	);
}

/** Attributes of a numeric <input>. */
export const numberAttrs = (min: number, max: number, placeholder?: string, step?: number): m.Attributes => ({
	type: "number",
	min,
	max,
	step,
	placeholder,
});
