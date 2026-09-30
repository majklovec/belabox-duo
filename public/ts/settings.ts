/* Device settings + pipeline repositories — a Mithril view over the WebSocket API. */
import m from "mithril";
import { Card, Page, badge, field } from "./components/ui";
import { byId } from "./dom";
import type { Params } from "./services/rpc";
import { RpcClient, socketUrl } from "./services/rpc";

interface Settings {
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
		state.message = error instanceof Error ? error.message : String(error);
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
		state.message = "Settings saved.";
		// Parameters may have changed on the device side; drop the socket so the
		// reconnect re-fetches fresh settings (hostname, role, color, …).
		rpc.reconnect();
	} catch (error: unknown) {
		state.message = error instanceof Error ? error.message : String(error);
	} finally {
		state.saving = false;
		m.redraw();
	}
}

async function addRepository(): Promise<void> {
	if (!state.repository.trim()) return;
	const repo = state.repository.trim();
	state.repoBusy = true;
	state.repoMessage = `Importing ${repo}...`;
	m.redraw();
	try {
		const response = await rpc.call<{ repositories: string[]; result: { files: number; bytes: number } }>(
			"pipelines.repositories.add",
			{ repository: repo } as Params,
		);
		state.repositories = response.repositories;
		state.repository = "";
		state.repoMessage = `Imported ${response.result.files} file(s).`;
	} catch (error: unknown) {
		state.repoMessage = error instanceof Error ? error.message : String(error);
	} finally {
		state.repoBusy = false;
		m.redraw();
	}
}

async function removeRepository(repository: string): Promise<void> {
	state.repoMessage = `Removing ${repository}...`;
	m.redraw();
	try {
		const result = await rpc.call<{ repositories: string[] }>("pipelines.repositories.remove", { repository });
		state.repositories = result.repositories;
		state.repoMessage = `${repository} removed.`;
	} catch (error: unknown) {
		state.repoMessage = error instanceof Error ? error.message : String(error);
	}
	m.redraw();
}

async function updateAllRepositories(): Promise<void> {
	state.repoBusy = true;
	state.repoMessage = "Updating all pipeline repositories...";
	m.redraw();
	try {
		const response = await rpc.call<{ results: Array<{ repository: string; files: number }> }>("pipelines.repositories.updateAll");
		const files = response.results.reduce((total, r) => total + r.files, 0);
		state.repoMessage = `Updated ${response.results.length} repository/repositories (${files} files).`;
	} catch (error: unknown) {
		state.repoMessage = error instanceof Error ? error.message : String(error);
	} finally {
		state.repoBusy = false;
		m.redraw();
	}
}

const App: m.Component<{}, {}> = {
	view: () => {
		const tokenPlaceholder = state.settings
			? state.settings.hasRemoteToken
				? "configured (leave blank to keep)"
				: "not configured"
			: "unchanged";
		return m(
			Page,
			{
				title: [m("a", { href: "../", title: "Back to device" }, "←"), " Device settings"],
				headerRight: badge(state.connected ? "connected" : "disconnected", state.connected ? "on" : "off"),
			},
			m(
				Card,
				null,
				m("p.muted", "Settings are re-applied on the control server after saving."),
						m(
							"form",
							{ onsubmit: (e: Event) => { e.preventDefault(); void save(); } },
							field(
								"Hostname",
								m("input", { value: state.hostname, pattern: hostnamePattern, oninput: (e: Event) => (state.hostname = (e.target as HTMLInputElement).value) }),
							),
							field(
								"Role",
								m(
									"select",
									{ value: state.role, onchange: (e: Event) => (state.role = (e.target as HTMLSelectElement).value) },
									m("option", { value: "" }, "Keep current"),
									m("option", { value: "relay" }, "Relay"),
									m("option", { value: "encoder" }, "Encoder"),
									m("option", { value: "combined" }, "Combined"),
								),
							),
							m("div.break"),
							field(
								"Header color",
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
								"Control server URL",
								m("input", { placeholder: "wss://control.example/device", value: state.remoteUrl, oninput: (e: Event) => (state.remoteUrl = (e.target as HTMLInputElement).value) }),
							),
							field(
								"Remote token",
								m("input", { type: "password", autocomplete: "off", placeholder: tokenPlaceholder, value: state.remoteToken, oninput: (e: Event) => (state.remoteToken = (e.target as HTMLInputElement).value) }),
							),
							m("div.break"),
							m("div.actions", m("button", { type: "submit", disabled: state.saving }, "Save settings")),
						),
				m("p.muted", { role: "status" }, state.message),
			),
			m(
				Card,
				{ title: "Pipeline repositories" },
				m("p.muted", null, "Pipelines are imported recursively from each repository's ", m("code", "pipeline"), " directory."),
						m(
							"form",
							{ onsubmit: (e: Event) => { e.preventDefault(); void addRepository(); } },
							field(
								"GitHub repository",
								m("input", { required: true, pattern: repoPattern, placeholder: "author/repository", value: state.repository, oninput: (e: Event) => (state.repository = (e.target as HTMLInputElement).value) }),
							),
							m(
								"div.actions",
								m("button", { type: "submit", disabled: state.repoBusy }, "Add repository"),
								m("button", { type: "button", class: "secondary", disabled: state.repoBusy, onclick: () => void updateAllRepositories() }, "Update all"),
							),
						),
						state.repositories.length
							? state.repositories.map(
									(repository) =>
										m(
											"div.card-head",
											{ key: repository },
											m("code", repository),
											m("button.danger", { type: "button", onclick: () => void removeRepository(repository) }, "Remove"),
										),
								)
							: m("p.muted", "No pipeline repositories configured."),
				m("p.muted", { role: "status" }, state.repoMessage),
			),
		);
	},
};

m.mount(byId("app"), App);
