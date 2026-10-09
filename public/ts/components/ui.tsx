/* Shared building blocks (header, cards, badges, definition lists, bound form
 * controls) for the Mithril views. Views are JSX trees (Bun's transform with the
 * `m` pragma); these helpers keep the markup consistent between pages and are
 * built on stock panda-ui-mithril components + its utility classes. */
import m from "mithril";
import { ChevronLeft } from "../icons";
import type { EncoderState, Role, SrtlaState } from "../../types";
import { LanguageSelect, t } from "../i18n";
import { asJSX, pum } from "../jsx";
import type { Child } from "../util";
import { Badge } from "panda-ui-mithril/badge";
import { Button } from "panda-ui-mithril/button";
import { Card as PumCardBase, CardActions, CardTitle } from "panda-ui-mithril/card";
import { Text } from "panda-ui-mithril/text";
import type { PumColor, PumSize } from "panda-ui-mithril";
import { css, cx } from "styled-system/css";

const PumBadge = pum(Badge);
const PumButton = pum(Button);
const PumCard = pum(PumCardBase);
const PumCardTitle = pum(CardTitle);
const PumCardActions = pum(CardActions);
const PumText = pum(Text);

export type { Child };

export interface PageProps {
	title: Child;
	nav?: Child;
	headerRight?: m.Children;
}

/** <header> + <main> page skeleton. The header carries the optional main menu, then the
 * language selector and the page's own `headerRight` actions on its right edge. */
export const Page = asJSX<PageProps>((v) => [
	<header class={css({display: "flex", alignItems: "center", gap: "0.75rem", paddingInline: "1rem", paddingBlock: "0.5rem"})}>
		<h1 class={css({fontSize: "1.125rem", lineHeight: "1.75rem", fontWeight: "600"})}>{v.attrs.title}</h1>
		{v.attrs.nav}
		<span class={css({display: "flex", alignItems: "center", gap: "0.5rem", marginLeft: "auto"})}>
			<LanguageSelect />
			{v.attrs.headerRight}
		</span>
	</header>,
	<main class={css({marginInline: "auto", maxWidth: "72rem", paddingInline: "1rem", paddingBlock: "1rem", display: "flex", flexDirection: "column", gap: "1rem"})}>{v.children}</main>
]);

export const TitleWithBack = asJSX<{ href?: string; backLabel: string }>((v) => {
	const { href, backLabel } = v.attrs;
	return [
		<PumButton
			variant="ghost"
			size="sm"
			square
			{...(href !== undefined ? { href, title: backLabel, "aria-label": backLabel } : {})}
		>
			<ChevronLeft size={16} />
		</PumButton>,
		" ",
		v.children,
	];
});

/** Main menu of the control server: the device list and the dashboards page. */
export const serverNav = (active: "devices" | "dashboards"): m.Vnode => (
	<span class={css({display: "flex", alignItems: "center", gap: "0.25rem"})}>
		<PumButton variant={active === "devices" ? "soft" : "ghost"} size="sm" href="/" active={active === "devices"}>
			{t("mgmt.devices")}
		</PumButton>
		<PumButton variant={active === "dashboards" ? "soft" : "ghost"} size="sm" href="/dashboards/" active={active === "dashboards"}>
			{t("dash.title")}
		</PumButton>
	</span>
);

export interface CardProps {
	/** Bare title. Use `headActions` for the title-plus-actions row. */
	title?: Child;
	/** Actions on the right of the title row. */
	headActions?: m.Children;
	/** Extra class(es) on the root (module scoping, e.g. `mod-modems`). */
	class?: string;
}

export const Card = asJSX<CardProps>((v) => {
	const { title, headActions, class: extra } = v.attrs;
	return (
		<PumCard class={extra}>
			{title !== undefined ? (
				headActions === undefined ? (
					<PumCardTitle>{title}</PumCardTitle>
				) : (
					<div class={css({display: "flex", alignItems: "center", gap: "0.5rem"})}>
						<PumCardTitle>{title}</PumCardTitle>
						<PumCardActions justify="end" class={css({marginLeft: "auto"})}>
							{headActions}
						</PumCardActions>
					</div>
				)
			) : null}
			{v.children}
		</PumCard>
	);
});

export type BadgeKind = "on" | "off" | "warn" | "";

/** Coloured status pill (kind → pum color); empty kind renders plain text. */
export const badge = (text: string, kind: BadgeKind = "") =>
	kind === "" ? <PumText as="span" size="sm" color="neutral">{text}</PumText> : (
		<PumBadge color={kind === "on" ? "success" : kind === "warn" ? "warning" : "neutral"} variant="soft">
			{text}
		</PumBadge>
	);

/** "connected" / "disconnected" header badge. */
export const connectionBadge = (connected: boolean) =>
	connected ? badge(t("dev.connected"), "on") : badge(t("dev.disconnected"), "off");

/** Encoder state badge when it is not simply streaming: stopped, srtla_send down (combined), restarting. */
export function encoderIssueBadge(role: Role | undefined, e: EncoderState, srtla: SrtlaState | undefined): m.Vnode | null {
	if (!e.running) return badge(t("dev.badge.stopped"), "off");
	if (role === "combined" && !srtla?.running) return badge(t("dev.badge.srtla_send_down"), "warn");
	if (!e.pid && e.restarts) return badge(t("dev.badge.restarting"), "warn");
	return null;
}

/** Muted inline text (the workhorse "secondary" copy). */
export const muted = (children: Child, as: "p" | "span" | "div" = "span", size: PumSize = "sm") => (
	<PumText as={as} color="neutral" size={size}>
		{children}
	</PumText>
);

/** <dl> of dt/dd rows; empty values render "—". */
export function definitionList(rows: [string, Child][]): m.Vnode {
	return (
		<dl class={css({display: "flex", flexDirection: "column", gap: "0.25rem"})}>
			{rows.map(([k, v], i) => (
				<div key={i} class={css({display: "flex", gap: "0.75rem", fontSize: "0.875rem", lineHeight: "1.25rem"})}>
					<dt class={css({width: "10rem", flexShrink: "0", color: "neutral"})}>{k}</dt>
					<dd>{v ?? "—"}</dd>
				</div>
			))}
		</dl>
	);
}

/** A <table> of th/td rows (dashboard widget bodies share this shape). */
export function widgetTable(rows: [string, Child][]): m.Vnode {
	return (
		<table class={css({width: "100%", fontSize: "0.875rem", lineHeight: "1.25rem"})}>
			<tbody>
				{rows.map(([label, value], i) => (
					<tr key={i} class={css({borderBottomWidth: "1px", borderStyle: "solid"})} style={{ borderColor: "var(--colors-neutral)" }}>
						<th scope="row" class={css({textAlign: "left", fontWeight: "400", color: "neutral", paddingBlock: "0.25rem", paddingRight: "1rem"})}>{label}</th>
						<td class={css({paddingBlock: "0.25rem"})}>{value}</td>
					</tr>
				))}
			</tbody>
		</table>
	);
}

export type ButtonTone = "primary" | "secondary" | "danger";

/** <button type="button">; pass `type: "submit"` for a form's default action. */
/** pum Button attrs without the lifecycle hooks (they clash with its own view type). */
type ButtonRest = Omit<m.Attributes, "oninit" | "oncreate" | "onupdate" | "onremove" | "onbeforeremove" | "onbeforeupdate" | "onbeforecreate">;

export const button = (label: Child, attrs: ButtonRest & { tone?: ButtonTone } = {}) => {
	const { tone = "primary", ...rest } = attrs;
	const color: PumColor = tone === "primary" ? "primary" : tone === "danger" ? "error" : "neutral";
	return (
		<PumButton color={color} variant={tone === "primary" ? "soft" : "outline"} {...(rest as ButtonRest)}>
			{label}
		</PumButton>
	);
};

/** Row of buttons. */
export const actions = (...children: m.Children[]): m.Vnode => <div class={css({display: "flex", alignItems: "center", gap: "0.5rem"})}>{children}</div>;

/** Line break inside a flex-wrapped form. */
export const brk = () => <div class={css({width: "100%"})} />;

/** Titled full-width group of related form fields (<fieldset> + <legend>). */
export const fieldGroup = (legend: Child, ...children: m.Children[]): m.Vnode => (
	<fieldset class={css({display: "flex", flexDirection: "column", gap: "0.5rem", marginBlock: "0.5rem"})}>
		<legend class={css({fontSize: "0.875rem", lineHeight: "1.25rem", fontWeight: "500", marginBottom: "0.25rem"})}>{legend}</legend>
		{children}
	</fieldset>
);

/** A <label> with a caption above its control; extra attrs (`class`, `hidden`, …) pass through. */
export function field(label: Child, control: m.Children, extra: m.Attributes = {}): m.Vnode {
	return (
		<label class={css({display: "flex", flexDirection: "column", gap: "0.25rem", fontSize: "0.875rem", lineHeight: "1.25rem"})} {...extra}>
			<span>{label}</span>
			{control}
		</label>
	);
}

/** A checkbox (or radios) with its caption after it. */
export function checkField(label: Child, control: m.Children, extra: m.Attributes = {}): m.Vnode {
	const { class: extraClass, ...rest } = extra as m.Attributes & { class?: string };
	return (
		<label class={cx(css({ display: "flex", alignItems: "center", gap: "0.5rem", fontSize: "0.875rem", lineHeight: "1.25rem" }), extraClass)} {...(rest as m.Attributes)}>
			{control}
			<span>{label}</span>
		</label>
	);
}

/** <option>s from [value, label] pairs. */
export const options = (pairs: readonly (readonly [string, string])[]): m.Vnode[] =>
	pairs.map(([value, label]) => <option key={value} value={value}>{label}</option>);

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
export const form = (attrs: m.Attributes & { onSubmit?: () => void; class?: string }, ...children: m.Children[]): m.Vnode => {
	const { onSubmit, class: extra, ...rest } = attrs;
	return (
		<form
			class={cx(css({ display: "flex", flexDirection: "column", gap: "0.75rem" }), extra)}
			{...(rest as m.Attributes)}
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
			class="input"
			{...(attrs as Record<string, unknown>)}
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
			class="select"
			{...(attrs as Record<string, unknown>)}
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
			type="checkbox"
			name={key}
			class="checkbox"
			{...(attrs as Record<string, unknown>)}
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
