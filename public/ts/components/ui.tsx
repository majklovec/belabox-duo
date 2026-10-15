/* Shared building blocks (header, cards, badges, definition lists, bound form controls)
 * for Mithril JSX views. These helpers keep markup consistent between pages. */
import m from "mithril";
import type { EncoderState, Role, SrtlaState } from "../../types";
import { LanguageSelect, t } from "../i18n";
import type { MithrilJSXComponent } from "../jsx";
import type { Child } from "../util";

export type { Child };

// -- Page skeleton -----------------------------------------------------------------

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

// -- Navigation --------------------------------------------------------------------

/** Main menu of the control server: the device list and the dashboards page. */
export const ServerNav = {
	view: ({ attrs: { active } }) => (
		<span>
			<a
				href={"/"}
				class={active === "devices" ? "nav-link active" : "nav-link"}
				aria-current={active === "devices" ? "page" : undefined}
			>
				{t("mgmt.devices")}
			</a>
			<a
				href={"/dashboards/"}
				class={active === "dashboards" ? "nav-link active" : "nav-link"}
				aria-current={active === "dashboards" ? "page" : undefined}
			>
				{t("dash.title")}
			</a>
		</span>
	),
} as MithrilJSXComponent<{ active: "devices" | "dashboards" }>;

// -- Cards -------------------------------------------------------------------------

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

// -- Badges ------------------------------------------------------------------------

export type BadgeKind = "on" | "off" | "warn" | "";

export const Badge = {
	view: ({ attrs: { text, kind = "" } }) => <span class={`badge ${kind}`.trim()}>{text}</span>,
} as MithrilJSXComponent<{ text: string; kind?: BadgeKind }>;

/** "connected" / "disconnected" header badge. */
export const ConnectionBadge = {
	view: ({ attrs: { connected } }) =>
		connected ? (
			<Badge text={t("dev.connected")} kind={"on"} />
		) : (
			<Badge text={t("dev.disconnected")} kind={"off"} />
		),
} as MithrilJSXComponent<{ connected: boolean }>;

/** Encoder state badge when it is not simply streaming: stopped, srtla_send down (combined), restarting. */
export const EncoderIssueBadge = {
	view: ({ attrs: { role, e, srtla } }) => {
		if (!e.running) return <Badge text={t("dev.badge.stopped")} kind={"off"} />;
		if (role === "combined" && !srtla?.running)
			return <Badge text={t("dev.badge.srtla_send_down")} kind={"warn"} />;
		if (!e.pid && e.restarts) return <Badge text={t("dev.badge.restarting")} kind={"warn"} />;
		return null;
	},
} as MithrilJSXComponent<{ role: Role | undefined; e: EncoderState; srtla: SrtlaState | undefined }>;

/** Whether `EncoderIssueBadge` would render a badge for this state (i.e. there is an issue). */
export function hasEncoderIssue(
	role: Role | undefined,
	e: EncoderState,
	srtla: SrtlaState | undefined,
): boolean {
	if (!e.running) return true;
	if (role === "combined" && !srtla?.running) return true;
	if (!e.pid && e.restarts) return true;
	return false;
}

// -- Definition lists / tables -----------------------------------------------------

/** <dl> of dt/dd rows; empty values render "—". */
export const DefinitionList = {
	view: ({ attrs: { rows } }) => (
		<dl>{rows.flatMap(([k, v]) => [<dt>{k}</dt>, <dd>{v ?? "—"}</dd>])}</dl>
	),
} as MithrilJSXComponent<{ rows: [string, Child][] }>;

/** A <table> of th/td rows (dashboard widget bodies share this shape). */
export const WidgetTable = {
	view: ({ attrs: { rows } }) => (
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
	),
} as MithrilJSXComponent<{ rows: [string, Child][] }>;

// -- Form building blocks ----------------------------------------------------------

/** A <label> with a caption above its control; extra attrs (`class`, `hidden`, …) pass through. */
export const Field = {
	view: ({ attrs: { label, control, ...extra } }) => (
		<label {...extra}>
			{label}
			{control}
		</label>
	),
} as MithrilJSXComponent<{ label: Child; control: m.Children } & m.Attributes>;

/** A checkbox (or radios) with its caption after it. */
export const CheckField = {
	view: ({ attrs: { label, control, class: extraClass, ...extra } }) => (
		<label {...extra} class={extraClass ? `${extraClass} check` : "check"}>
			{control}
			{label}
		</label>
	),
} as MithrilJSXComponent<{ label: Child; control: m.Children; class?: string } & m.Attributes>;

/** <button type="button">; pass `type: "submit"` for a form's default action. */
export const Button = {
	view: ({ attrs: { label, ...rest } }) => (
		<button type={"button"} {...rest}>
			{label}
		</button>
	),
} as MithrilJSXComponent<{ label: Child } & m.Attributes>;

/** <div.actions> row of buttons. */
export const Actions = {
	view: ({ children }) => <div class={"actions"}>{children}</div>,
} as MithrilJSXComponent<{ children?: m.Children }>;

/** Line break inside a flex-wrapped form. */
export const Break = {
	view: (v) => <div class={"break"} />,
} as MithrilJSXComponent<{ children?: m.Children }>;

/** Titled full-width group of related form fields (<fieldset> + <legend>). */
export const FieldGroup = {
	view: ({ attrs: { legend }, children }) => (
		<fieldset class={"group"}>
			<legend>{legend}</legend>
			{children}
		</fieldset>
	),
} as MithrilJSXComponent<{ legend: Child }>;

/** <option>s from [value, label] pairs. */
export const Options = {
	view: ({ attrs: { pairs } }) =>
		pairs.map(([value, label]) => (
			<option key={value} value={value}>
				{label}
			</option>
		)),
} as MithrilJSXComponent<{ pairs: readonly (readonly [string, string])[] }>;

export const AudioCodecOptions = {
	view: (v) => (
		<Options
			pairs={[
				["aac", "AAC"],
				["opus", "Opus"],
			]}
		/>
	),
} as MithrilJSXComponent<{ children?: m.Children }>;

/** srtla_send scheduler modes. */
export const SchedulerOptions = {
	view: (v) => (
		<Options
			pairs={[
				["enhanced", t("dev.scheduler_enhanced")],
				["classic", t("dev.scheduler_classic")],
			]}
		/>
	),
} as MithrilJSXComponent<{ children?: m.Children }>;

/** <form> whose submit runs `onSubmit` instead of navigating. */
export const Form = {
	view: ({ attrs: { onSubmit, ...rest }, children }) => (
		<form
			{...rest}
			onsubmit={(e: Event) => {
				e.preventDefault();
				onSubmit?.();
			}}
		>
			{children}
		</form>
	),
} as MithrilJSXComponent<{ onSubmit?: () => void } & m.Attributes>;

// -- Controls two-way bound to a property of a state object ------------------------

/** Keys of `T` whose values are `V`. */
export type KeysOf<T, V> = { [K in keyof T]-?: T[K] extends V ? K : never }[keyof T] & string;

/** Shared props for the bound controls below. `prop` names a property on `target`. */
export interface BoundProps {
	target: object;
	prop: string;
}

/** <input> bound to the string `target[prop]`; `name` defaults to `prop`. */
export const Input = {
	view: ({ attrs: { target, prop, onChange, ...rest } }) => {
		const state = target as Record<string, unknown>;
		return (
			<input
				name={prop}
				{...rest}
				value={state[prop] as string}
				oninput={(e: Event) => {
					const value = (e.target as HTMLInputElement).value;
					state[prop] = value;
					onChange?.(value);
				}}
			/>
		);
	},
} as MithrilJSXComponent<BoundProps & { onChange?: (value: string) => void } & m.Attributes>;

/** <select> bound to the string `target[prop]`. */
export const Select = {
	view: ({ attrs: { target, prop, onChange, ...rest }, children }) => {
		const state = target as Record<string, unknown>;
		return (
			<select
				name={prop}
				{...rest}
				value={state[prop] as string}
				onchange={(e: Event) => {
					const value = (e.target as HTMLSelectElement).value;
					state[prop] = value;
					onChange?.(value);
				}}
			>
				{children}
			</select>
		);
	},
} as MithrilJSXComponent<BoundProps & { onChange?: (value: string) => void } & m.Attributes>;

/** Checkbox bound to the boolean `target[prop]`. */
export const Checkbox = {
	view: ({ attrs: { target, prop, onChange, ...rest } }) => {
		const state = target as Record<string, unknown>;
		return (
			<input
				type={"checkbox"}
				name={prop}
				{...rest}
				checked={state[prop] as boolean}
				onchange={(e: Event) => {
					const checked = (e.target as HTMLInputElement).checked;
					state[prop] = checked;
					onChange?.(checked);
				}}
			/>
		);
	},
} as MithrilJSXComponent<BoundProps & { onChange?: (checked: boolean) => void } & m.Attributes>;

/** Attributes of a numeric <input>. (Plain function — it returns attrs, not a vnode.) */
export const numberAttrs = (min: number, max: number, placeholder?: string, step?: number): m.Attributes => ({
	type: "number",
	min,
	max,
	step,
	placeholder,
});
