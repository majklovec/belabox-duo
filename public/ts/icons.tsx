/* The app's icon set: every glyph comes from lucide (lucide-mithril).
 *
 * lucide-mithril components are Mithril `{view}` objects, and TS's JSX type
 * checking additionally requires element types to be callable — so each icon
 * we use is re-exported through the shared JSX adapter. */
import m from "mithril";
import * as L from "lucide-mithril";
import type { Role } from "../types";
import { t } from "./i18n";
import { pum } from "./jsx";
import { css } from "styled-system/css";

export type IconProps = m.Attributes & { size?: number };

const wrapIcon = (c: m.Component<m.Attributes>) => pum<IconProps>(c);

export const Check = wrapIcon(L.Check);
export const ChevronLeft = wrapIcon(L.ChevronLeft);
export const CircleX = wrapIcon(L.CircleX);
export const CornerDownRight = wrapIcon(L.CornerDownRight);
export const Eye = wrapIcon(L.Eye);
export const GripVertical = wrapIcon(L.GripVertical);
export const Info = wrapIcon(L.Info);
export const LayoutGrid = wrapIcon(L.LayoutGrid);
export const Maximize = wrapIcon(L.Maximize);
export const Mic = wrapIcon(L.Mic);
export const MicOff = wrapIcon(L.MicOff);
export const Minimize = wrapIcon(L.Minimize);
export const MonitorPlay = wrapIcon(L.MonitorPlay);
export const Pencil = wrapIcon(L.Pencil);
export const Puzzle = wrapIcon(L.Puzzle);
export const Radio = wrapIcon(L.Radio);
export const Settings = wrapIcon(L.Settings);
export const Trash2 = wrapIcon(L.Trash2);
export const TriangleAlert = wrapIcon(L.TriangleAlert);
export const Video = wrapIcon(L.Video);
export const X = wrapIcon(L.X);

export type Level = "info" | "warn" | "error";

/** Log-line level glyph. */
export const levelIcon = (level: Level): m.Vnode => {
	const Icon = level === "info" ? Info : level === "warn" ? TriangleAlert : CircleX;
	return <Icon size={14} />;
};

/** Role icon: encoder → Video, relay → Radio, combined → both, obs → MonitorPlay,
 * custom → Puzzle; the gear covers empty roles. */
export const roleIcon = (role: Role | undefined, size = 16): m.Vnode => {
	switch (role) {
		case "encoder":
			return <Video size={size} />;
		case "relay":
			return <Radio size={size} />;
		case "combined":
			return (
				<span class={css({display: "inline-flex", alignItems: "center", gap: "0.125rem"})}>
					<Video size={size} />
					<Radio size={size} />
				</span>
			);
		case "obs":
			return <MonitorPlay size={size} />;
		case "custom":
			return <Puzzle size={size} />;
		default:
			return <Settings size={size} />;
	}
};

/** Single role glyph (alias kept for the column headers). */
export const icon = (role: Role | undefined, size = 16): m.Vnode => roleIcon(role, size);

/** The larger role glyph for the setup wizard's role cards. */
export const roleCardIcon = (role: Role): m.Vnode => roleIcon(role, 32);

/** Role icon(s) with the translated role as tooltip; combined devices get both icons. */
export const roleTag = (role: Role): m.Vnode => (
	<span class={css({display: "inline-flex"})} title={t(`role.${role}`)}>
		{role === "combined" ? [roleIcon("encoder"), roleIcon("relay")] : roleIcon(role)}
	</span>
);

const gearIcon = (): m.Vnode => <Settings size={18} />;
const dashboardIcon = (): m.Vnode => <LayoutGrid size={18} />;

/** Row-action glyph for the dashboard pages. */
const actionIcon = (action: "fullscreen" | "exitFullscreen" | "view" | "edit" | "delete"): m.Vnode => {
	switch (action) {
		case "fullscreen":
			return <Maximize size={18} />;
		case "exitFullscreen":
			return <Minimize size={18} />;
		case "view":
			return <Eye size={18} />;
		case "edit":
			return <Pencil size={18} />;
		default:
			return <Trash2 size={18} />;
	}
};

export { gearIcon, dashboardIcon, actionIcon };
