/* Inline SVG icons (stroked with the current text colour). Mithril sets the SVG namespace
 * automatically, so plain tag names render as SVG children. */
import m from "mithril";
import { t } from "./i18n";
import type { Role } from "../types";

type ShapeTag = "circle" | "path" | "rect";
type Shape = readonly (readonly [ShapeTag, Record<string, string>])[];

// 24×24 outline shapes: a video camera for the encoder, a broadcasting antenna for the relay.
const ROLE_SHAPES = {
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
	obs: [
		["rect", { x: "2", y: "3", width: "20", height: "14", rx: "2" }],
		["path", { d: "m9 7 5 3.5L9 14z" }],
		["path", { d: "M8 21h8M12 17v4" }],
	],
	custom: [
		["rect", { x: "3", y: "3", width: "8", height: "8", rx: "1.5" }],
		["rect", { x: "13", y: "3", width: "8", height: "8", rx: "1.5" }],
		["rect", { x: "3", y: "13", width: "8", height: "8", rx: "1.5" }],
		["path", { d: "M17 13v8M13 17h8" }],
	],
} as const satisfies Record<string, Shape>;

// Four-tile pictogram that marks the dashboard editor page
const DASHBOARD: Shape = [
	["rect", { x: "3", y: "3", width: "8", height: "8", rx: "1.5" }],
	["rect", { x: "13", y: "3", width: "8", height: "8", rx: "1.5" }],
	["rect", { x: "3", y: "13", width: "8", height: "8", rx: "1.5" }],
	["rect", { x: "13", y: "13", width: "8", height: "8", rx: "1.5" }],
];

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
} as const satisfies Record<string, Shape>;

// Larger role pictograms for the setup wizard's role cards
const ROLE_CARD_SHAPES = {
	encoder: [
		["rect", { x: "2", y: "7", width: "13", height: "10", rx: "2" }],
		["path", { d: "m15 11 7-3v8l-7-3z" }],
	],
	relay: [
		["rect", { x: "1.5", y: "9", width: "7", height: "6", rx: "1.5" }],
		["rect", { x: "15.5", y: "9", width: "7", height: "6", rx: "1.5" }],
		["path", { d: "M9 12h6" }],
		["path", { d: "m13.5 9.5 2.5 2.5-2.5 2.5" }],
		["path", { d: "m10.5 9.5-2.5 2.5 2.5 2.5" }],
	],
	combined: [
		["rect", { x: "1.5", y: "8.5", width: "10", height: "7", rx: "1.5" }],
		["path", { d: "m11.5 11 4-2v4l-4-2z" }],
		["path", { d: "M17.5 12H23" }],
		["path", { d: "m21 10 2 2-2 2" }],
	],
	obs: [
		["rect", { x: "2", y: "3", width: "20", height: "14", rx: "2" }],
		["path", { d: "m9 7 5 3.5L9 14z" }],
		["path", { d: "M8 21h8M12 17v4" }],
	],
	custom: [
		["rect", { x: "3", y: "3", width: "8", height: "8", rx: "1.5" }],
		["rect", { x: "13", y: "3", width: "8", height: "8", rx: "1.5" }],
		["rect", { x: "3", y: "13", width: "8", height: "8", rx: "1.5" }],
		["path", { d: "M17 13v8M13 17h8" }],
	],
} as const satisfies Record<Role, Shape>;

const GEAR: Shape = [
	["circle", { cx: "12", cy: "12", r: "3" }],
	[
		"path",
		{
			d: "M19.4 15a1.7 1.7 0 0 0 .3 1.9l.1.1-2.8 2.8-.1-.1a1.7 1.7 0 0 0-1.9-.3 1.7 1.7 0 0 0-1 1.6v.2h-4V21a1.7 1.7 0 0 0-1-1.6 1.7 1.7 0 0 0-1.9.3l-.1.1L4.2 17l.1-.1a1.7 1.7 0 0 0 .3-1.9A1.7 1.7 0 0 0 3 14H2.8v-4H3a1.7 1.7 0 0 0 1.6-1 1.7 1.7 0 0 0-.3-1.9L4.2 7 7 4.2l.1.1A1.7 1.7 0 0 0 9 4.6a1.7 1.7 0 0 0 1-1.6v-.2h4V3a1.7 1.7 0 0 0 1 1.6 1.7 1.7 0 0 0 1.9-.3l.1-.1L19.8 7l-.1.1a1.7 1.7 0 0 0-.3 1.9 1.7 1.7 0 0 0 1.6 1h.2v4H21a1.7 1.7 0 0 0-1.6 1Z",
		},
	],
];

export type Level = keyof typeof LEVEL_SHAPES;

const shapeElement = {
	circle: (attrs: Record<string, string>) => <circle {...attrs} />,
	path: (attrs: Record<string, string>) => <path {...attrs} />,
	rect: (attrs: Record<string, string>) => <rect {...attrs} />,
};

function draw(parts: Shape, attrs: m.Attributes): m.Vnode {
	return (
		<svg viewBox="0 0 24 24" aria-hidden="true" {...attrs}>
			{parts.map(([tag, partAttrs]) => shapeElement[tag](partAttrs))}
		</svg>
	);
}

export const icon = (shape: keyof typeof ROLE_SHAPES): m.Vnode =>
	draw(ROLE_SHAPES[shape], { class: `role-icon role-icon-${shape}` });

export const levelIcon = (level: Level): m.Vnode => draw(LEVEL_SHAPES[level], { class: "role-icon log-icon" });

export const roleCardIcon = (role: Role): m.Vnode =>
	draw(ROLE_CARD_SHAPES[role], {
		class: "role-icon",
		width: "36",
		height: "36",
		fill: "none",
		stroke: "currentColor",
		"stroke-width": "1.6",
		"stroke-linecap": "round",
		"stroke-linejoin": "round",
	});

export const gearIcon = (): m.Vnode =>
	draw(GEAR, { width: "18", height: "18", fill: "none", stroke: "currentColor", "stroke-width": "2" });

export const dashboardIcon = (): m.Vnode =>
	draw(DASHBOARD, { width: "18", height: "18", fill: "none", stroke: "currentColor", "stroke-width": "2" });

const ACTION_SHAPES = {
	fullscreen: [["path", { d: "M8 3H3v5M16 3h5v5M21 16v5h-5M8 21H3v-5" }]],
	exitFullscreen: [["path", { d: "M3 8h5V3M21 8h-5V3M16 21v-5h5M8 21v-5H3" }]],
	view: [
		["path", { d: "M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7S2 12 2 12Z" }],
		["circle", { cx: "12", cy: "12", r: "3" }],
	],
	edit: [["path", { d: "m16 3 5 5-12 12-6 1 1-6L16 3ZM13 6l5 5" }]],
	delete: [["path", { d: "M3 6h18M9 6V3h6v3M5 6l1 15h12l1-15M10 10v7M14 10v7" }]],
} as const satisfies Record<string, Shape>;

export const actionIcon = (action: keyof typeof ACTION_SHAPES): m.Vnode =>
	draw(ACTION_SHAPES[action], {
		width: "18",
		height: "18",
		fill: "none",
		stroke: "currentColor",
		"stroke-width": "1.75",
		"stroke-linecap": "round",
		"stroke-linejoin": "round",
	});

/** Role icon(s) with the translated role as tooltip; combined devices get both icons. */
export const roleTag = (role: Role): m.Vnode => (
	<span class="role" title={t(`role.${role}`)}>
		{role === "combined" ? [icon("encoder"), icon("relay")] : icon(role)}
	</span>
);
