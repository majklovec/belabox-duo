/* Device page — a Mithril view over the device store (device/store.ts): header, one card per
 * role-specific function, and the event log. The WebSocket client mutates state and redraws. */
import m from "mithril";
import { badge, muted, Page, TitleWithBack, checkField } from "./components/ui";
import { interfacesCard } from "./device/interfaces";
import { LogCard } from "./device/log";
import { pum } from "./jsx";
import { moduleCard } from "../../src/registry.frontend";
import { act, connectDevice, st } from "./device/store";
import { t } from "./i18n";
import { gearIcon, roleTag } from "./icons";
import { mountPage } from "./util";
import { css } from "styled-system/css";

const LogCardView = pum(LogCard);

// The store's websocket is lazy (surfaces like the dashboard import the store
// without a device to talk to): open it on the device page.
connectDevice();

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
		checkField(t("ui.autostart"), (
			<input
				type="checkbox"
				checked={status?.state.autostart ?? false}
				disabled={!status || st.autostartBusy}
				onchange={(e: Event) => void setAutostart((e.target as HTMLInputElement).checked)}
			/>
		), { title: t("dev.autostart_title") }),
		status ? <span class={css({display: "inline-flex", alignItems: "center"})}>{roleTag(status.role)}</span> : null,
		connBadge(),
		<a class={css({display: "inline-flex", alignItems: "center", borderRadius: "0.375rem", padding: "0.25rem", "&:hover": {backgroundColor: "neutral/10"}})} href="settings/" title={t("set.title")} aria-label={t("set.title")}>
			{gearIcon()}
		</a>,
	];
}

const App: m.Component = {
	view: () => {
		const status = st.status;
		const role = status?.role;
		const hasEncoder = !!status && role !== "relay";
		const hasRelay = !!status && role !== "encoder";
		// A dedicated OBS box (role "obs") is a preview/scene deck only — the
		// SRT/streaming cards would be inactive there.
		const obsOnly = !!status && role === "obs";
		const obsOn = status?.modules["obs-controller"]?.enabled === true;
		// The obs card also carries its low-bitrate switcher (a second card under it)
		const children = [
			!obsOnly && hasEncoder && moduleCard("encoder", status),
			!obsOnly && hasRelay && [moduleCard("srtla", status), interfacesCard(status), moduleCard("modems", status)],
			obsOn && moduleCard("obs-controller", status),
		];
		return (
			<Page
				title={(
					<TitleWithBack href={st.device ? "../../" : undefined} backLabel={t("dev.all_devices_title")}>
						{`${t("dev.title")} `}
						{st.device && muted(st.device.hostname || st.device.id)}
					</TitleWithBack>
				)}
				headerRight={headerRight()}
			>
				{children}
				<LogCardView />
			</Page>
		);
	},
};

// Refresh relative times ("12s ago") and stats staleness without waiting for a push
setInterval(() => {
	if (st.status || st.stats) m.redraw();
}, 5_000);

void mountPage(() => t("dev.title"), App);
