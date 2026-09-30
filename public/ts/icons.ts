/* Device type and log level icons (inline SVG, stroked with the current text colour). */
import m from "mithril";
import type { Role } from "../types";

// 24×24 outline shapes: a video camera for the encoder, a broadcasting antenna for the relay.
// Mithril sets the SVG namespace automatically, so plain tag names render as SVG children.
const SHAPES = {
	encoder: [
		["rect", { x: "2", y: "6", width: "14", height: "12", rx: "2" }],
		["path", { d: "M16 10.5 22 7v10l-6-3.5z" }],
	],
	relay: [
		["circle", { cx: "12", cy: "9", r: "2" }],
		["path", { d: "M12 11v11M9 22h6" }],
		["path", { d: "M8.5 5.5a5 5 0 0 0 0 7M15.5 5.5a5 5 0 0 1 0 7" }],
		["path", { d: "M5.6 2.6a9 9 0 0 0 0 12.8M18.4 2.6a9 9 0 0 1 0 12.8" }],
	],
} as const;

export type Shape = keyof typeof SHAPES;

// Log level markers, in the same 24×24 outline style
const LEVEL_SHAPES = {
	info: [
		["circle", { cx: "12", cy: "12", r: "10" }],
		["path", { d: "M12 16v-5M12 8h.01" }],
	],
	warn: [
		["path", { d: "M10.3 3.9 1.8 18a2 2 0 0 0 1.7 3h17a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0z" }],
		["path", { d: "M12 9v4M12 17h.01" }],
	],
	error: [
		["circle", { cx: "12", cy: "12", r: "10" }],
		["path", { d: "m15 9-6 6M9 9l6 6" }],
	],
} as const;

export type Level = keyof typeof LEVEL_SHAPES;

export const ROLE_LABEL: Record<Role, string> = { relay: "relay", encoder: "encoder", combined: "encoder + relay" };

function draw(parts: readonly (readonly [string, Record<string, string>])[], className: string): m.Vnode {
	return m(
		"svg",
		{ viewBox: "0 0 24 24", class: className, "aria-hidden": "true" },
		...parts.map(([tag, attrs]) => m(tag, attrs)),
	);
}

export const icon = (shape: Shape): m.Vnode => draw(SHAPES[shape], `role-icon role-icon-${shape}`);

export const levelIcon = (level: Level): m.Vnode => draw(LEVEL_SHAPES[level], "role-icon log-icon");

/** Icon(s) for a role: combined devices get both the encoder and the relay icon. */
export function roleIcons(role: Role): m.Vnode[] {
	return role === "combined" ? [icon("encoder"), icon("relay")] : [icon(role)];
}

/** Icons followed by the role label, e.g. for a badge or table cell. */
export const roleTag = (role: Role): m.Vnode =>
	m("span", { class: "role", title: ROLE_LABEL[role] }, roleIcons(role));
