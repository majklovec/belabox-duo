/* Device settings + pipeline repositories — a Mithril view over the WebSocket API. */
import m from "mithril";
import { t } from "./i18n";
import { Card, Page, badge, field } from "./components/ui";
import { byId } from "./dom";
import type { Params } from "./services/rpc";
import { RpcClient, socketUrl } from "./services/rpc";
import { errorMessage } from "../../src/util";

interface Settings {
	/** Stable identity on the control server; hostnames change, the uuid does not */
	uuid: string;
	hostname: string;
	role: string;
	remoteUrl: string;
	hasRemoteToken: boolean;
	color: string;
	pipelineRepositories: string[];
}

const repoPattern = "[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+";
const hostnamePattern = "[A-Za-z0-9][A-Za-z0-9.-]{0,62}";

const state = {
	connected: false,
	settings: null as Settings | null,
	// Form fields (committed values plus the fields the user is editing)
	hostname: "",
	role: "",
	color: "#0f1115",
	remoteUrl: "",
	remoteToken: "",
	// Repository section
	repository: "",
	repositories: [] as string[],
	message: "",
	repoMessage: "",
	saving: false,
	repoBusy: false,
};

const rpc = new RpcClient(() => socketUrl("../ws"));
rpc.on("open", () => {
	state.connected = true;
	state.settings = null;
	m.redraw();
	void load();
});
rpc.on("close", () => {
	state.connected = false;
	m.redraw();
});

async function load(): Promise<void> {
	try {
		const result = await rpc.call<{ settings: Settings }>("settings.get");
		state.settings = result.settings;
		state.hostname = result.settings.hostname;
		state.role = result.settings.role;
		state.color = result.settings.color;
		state.remoteUrl = result.settings.remoteUrl;
		state.repositories = result.settings.pipelineRepositories;
		document.documentElement.style.setProperty("--header-color", result.settings.color);
	} catch (error: unknown) {
		state.message = errorMessage(error);
	}
	m.redraw();
}

async function save(): Promise<void> {
	state.saving = true;
	state.message = "";
	m.redraw();
	try {
		const result = await rpc.call<{ settings: Settings }>("settings.update", {
			hostname: state.hostname,
			role: state.role,
			remoteUrl: state.remoteUrl,
			color: state.color,
			...(state.remoteToken ? { remoteToken: state.remoteToken } : {}),
		} as Params);
		state.remoteToken = "";
		const roleChanged = result.settings.role !== state.settings?.role;
		state.message = roleChanged
			? `${t("set.saved")} ${t("set.restart_required")}`
			: t("set.saved");
		// Parameters may have changed on the device side; drop the socket so the
		// reconnect re-fetches fresh settings (hostname, role, color, …).
		rpc.reconnect();
	} catch (error: unknown) {
		state.message = errorMessage(error);
	} finally {
		state.saving = false;
		m.redraw();
	}
}

async function addRepository(): Promise<void> {
	if (!state.repository.trim()) return;
	const repo = state.repository.trim();
	state.repoBusy = true;
	state.repoMessage = t("set.repo_importing", repo);
	m.redraw();
	try {
		const response = await rpc.call<{ repositories: string[]; result: { files: number; bytes: number } }>(
			"pipelines.repositories.add",
			{ repository: repo } as Params,
		);
		state.repositories = response.repositories;
		state.repository = "";
		state.repoMessage = t("set.repo_imported", response.result.files);
	} catch (error: unknown) {
		state.repoMessage = errorMessage(error);
	} finally {
		state.repoBusy = false;
		m.redraw();
	}
}

async function removeRepository(repository: string): Promise<void> {
	state.repoMessage = t("set.repo_removing", repository);
	m.redraw();
	try {
		const result = await rpc.call<{ repositories: string[] }>("pipelines.repositories.remove", { repository });
		state.repositories = result.repositories;
		state.repoMessage = t("set.repo_removed", repository);
	} catch (error: unknown) {
		state.repoMessage = errorMessage(error);
	}
	m.redraw();
}

async function updateAllRepositories(): Promise<void> {
	state.repoBusy = true;
	state.repoMessage = t("set.repo_updating_all");
	m.redraw();
	try {
		const response = await rpc.call<{ results: Array<{ repository: string; files: number }> }>("pipelines.repositories.updateAll");
		const files = response.results.reduce((total, r) => total + r.files, 0);
		state.repoMessage = t("set.repo_updated_all", response.results.length, files);
	} catch (error: unknown) {
		state.repoMessage = errorMessage(error);
	} finally {
		state.repoBusy = false;
		m.redraw();
	}
}

const App: m.Component<{}, {}> = {
	view: () => {
		const tokenPlaceholder = state.settings
			? state.settings.hasRemoteToken
				? t("set.token_ph_configured")
				: t("set.token_ph_missing")
			: t("set.token_ph_unchanged");
		return m(
			Page,
			{
				title: [m("a", { href: "../", title: t("set.back") }, "←"), ` ${t("set.title")}`],
				headerRight: badge(state.connected ? t("dev.connected") : t("dev.disconnected"), state.connected ? "on" : "off"),
			},
			m(
				Card,
				null,
				m("p.muted", t("set.description")),
						m(
							"form",
							{ onsubmit: (e: Event) => { e.preventDefault(); void save(); } },
							field(
								t("set.hostname"),
								m("input", { value: state.hostname, pattern: hostnamePattern, oninput: (e: Event) => (state.hostname = (e.target as HTMLInputElement).value) }),
							),
							field(
								t("set.role"),
								m(
									"select",
									{ value: state.role, onchange: (e: Event) => (state.role = (e.target as HTMLSelectElement).value) },
									m("option", { value: "" }, t("set.role_keep")),
									m("option", { value: "relay" }, t("role.relay")),
									m("option", { value: "encoder" }, t("role.encoder")),
									m("option", { value: "combined" }, t("role.combined")),
								),
							),
							m("div.break"),
							field(
								t("set.color"),
								m("input", {
									type: "color",
									value: state.color,
									oninput: (e: Event) => {
										state.color = (e.target as HTMLInputElement).value;
										document.documentElement.style.setProperty("--header-color", state.color);
									},
								}),
							),
							m("div.break"),
							field(
								t("set.remote_url"),
								m("input", { placeholder: "wss://control.example/device", value: state.remoteUrl, oninput: (e: Event) => (state.remoteUrl = (e.target as HTMLInputElement).value) }),
							),
							field(
								t("set.remote_token"),
								m("input", { type: "password", autocomplete: "off", placeholder: tokenPlaceholder, value: state.remoteToken, oninput: (e: Event) => (state.remoteToken = (e.target as HTMLInputElement).value) }),
							),
							m("div.break"),
							m("div.actions", m("button", { type: "submit", disabled: state.saving }, t("set.save"))),
						),
				m("p.muted", { role: "status" }, state.message),
			),
			m(
				Card,
			{ title: t("set.repos") },
			m("p.muted", t("set.repos_desc")),
						m(
							"form",
							{ onsubmit: (e: Event) => { e.preventDefault(); void addRepository(); } },
							field(
								t("set.repo_field"),
								m("input", { required: true, pattern: repoPattern, placeholder: "author/repository", value: state.repository, oninput: (e: Event) => (state.repository = (e.target as HTMLInputElement).value) }),
							),
							m(
								"div.actions",
								m("button", { type: "submit", disabled: state.repoBusy }, t("set.repo_add")),
								m("button", { type: "button", class: "secondary", disabled: state.repoBusy, onclick: () => void updateAllRepositories() }, t("set.repo_update_all")),
							),
						),
						state.repositories.length
							? state.repositories.map(
									(repository) =>
										m(
											"div.card-head",
											{ key: repository },
											m("code", repository),
											m("button.danger", { type: "button", onclick: () => void removeRepository(repository) }, t("ui.remove")),
										),
								)
							: m("p.muted", t("set.no_repos")),
				m("p.muted", { role: "status" }, state.repoMessage),
			),
		);
	},
};

document.title = t("set.title");
m.mount(byId("app"), App);
