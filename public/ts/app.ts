/* Device page — a Mithril view over the device store (device/store.ts): header, one card per
 * role-specific function, and the event log. The WebSocket client mutates state and redraws. */
import m from "mithril";
import { badge, Page } from "./components/ui";
import { encoderCard } from "./device/encoder";
import { interfacesCard } from "./device/interfaces";
import { LogCard } from "./device/log";
import { srtlaCard } from "./device/srtla";
import { moduleCard } from "../../modules/registry.frontend";
import { act, st } from "./device/store";
import { t } from "./i18n";
import { gearIcon, roleTag } from "./icons";
import { mountPage } from "./util";

function connBadge(): m.Vnode {
	if (!st.socketOpen) return badge(t("dev.disconnected"), "off");
	if (st.device && !st.device.online) return badge(t("dev.device_offline"), "warn");
	return badge(t("dev.connected"), "on");
}

async function setAutostart(enabled: boolean): Promise<void> {
	const status = st.status;
	if (!status || st.autostartBusy) return;
	st.autostartBusy = true;
	const previous = status.state.autostart;
	status.state.autostart = enabled; // optimistic
	const result = await act<{ autostart: boolean }>(null, "autostart.set", { enabled });
	st.autostartBusy = false;
	status.state.autostart = result ? result.autostart : previous;
	m.redraw();
}

function headerRight(): m.Children[] {
	const status = st.status;
	return [
		m(
			"label.check",
			{ title: t("dev.autostart_title") },
			m("input", {
				type: "checkbox",
				checked: status?.state.autostart ?? false,
				disabled: !status || st.autostartBusy,
				onchange: (e: Event) => void setAutostart((e.target as HTMLInputElement).checked),
			}),
			` ${t("ui.autostart")}`,
		),
		status && m("span.badge", roleTag(status.role)),
		connBadge(),
		m("a.icon-link", { href: "settings/", title: t("set.title"), "aria-label": t("set.title") }, gearIcon()),
	];
}

const App: m.Component = {
	view: () => {
		const status = st.status;
		const role = status?.role;
		const hasEncoder = !!status && role !== "relay";
		const hasRelay = !!status && role !== "encoder";
		const children = [
			hasEncoder && encoderCard(status),
			hasRelay && [srtlaCard(status), interfacesCard(status), moduleCard("modems", status)],
		];
		return m(
			Page,
			{
				title: [
					st.device && m("a", { href: "../../", title: t("dev.all_devices_title") }, "←"),
					` ${t("dev.title")} `,
					st.device && m("span.muted", st.device.hostname || st.device.id),
				],
				headerRight: headerRight(),
			},
			children,
			m(LogCard),
		);
	},
};

// Refresh relative times ("12s ago") and stats staleness without waiting for a push
setInterval(() => {
	if (st.status || st.stats) m.redraw();
}, 5_000);

mountPage(t("dev.title"), App);
