/* Device settings + pipeline repositories — a Mithril view over the WebSocket API. */
import m from "mithril";
import { errorMessage } from "../../src/util";
import {
	actions,
	brk,
	button,
	Card,
	connectionBadge,
	field,
	form,
	input,
	options,
	Page,
	select,
} from "./components/ui";
import { t } from "./i18n";
import { RpcClient, socketUrl } from "./services/rpc";
import { HOSTNAME_PATTERN, mountPage, setHeaderColor } from "./util";

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

const REPO_PATTERN = "[A-Za-z0-9_.\\-]+/[A-Za-z0-9_.\\-]+";

const state = {
	connected: false,
	settings: null as Settings | null,
	message: "",
	saving: false,
	// Repository section
	repository: "",
	repositories: [] as string[],
	repoMessage: "",
	repoBusy: false,
};

/** Editable copy of the settings; the token is write-only (never sent back by the device). */
const draft = { hostname: "", role: "", color: "#0f1115", remoteUrl: "", remoteToken: "" };

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

/** Run an RPC call, routing its error message into `state[messageKey]`; redraws afterwards. */
async function run<T>(messageKey: "message" | "repoMessage", call: () => Promise<T>): Promise<T | undefined> {
	try {
		return await call();
	} catch (error: unknown) {
		state[messageKey] = errorMessage(error);
		return undefined;
	} finally {
		m.redraw();
	}
}

async function load(): Promise<void> {
	const result = await run("message", () => rpc.call<{ settings: Settings }>("settings.get"));
	if (!result) return;
	const s = result.settings;
	state.settings = s;
	state.repositories = s.pipelineRepositories;
	Object.assign(draft, { hostname: s.hostname, role: s.role, color: s.color, remoteUrl: s.remoteUrl });
	setHeaderColor(s.color);
}

async function save(): Promise<void> {
	state.saving = true;
	state.message = "";
	const { remoteToken, ...rest } = draft;
	const result = await run("message", () =>
		rpc.call<{ settings: Settings }>("settings.update", { ...rest, ...(remoteToken ? { remoteToken } : {}) }),
	);
	state.saving = false;
	if (!result) return;
	draft.remoteToken = "";
	const roleChanged = result.settings.role !== state.settings?.role;
	state.message = roleChanged ? `${t("set.saved")} ${t("set.restart_required")}` : t("set.saved");
	// Parameters may have changed on the device side; drop the socket so the
	// reconnect re-fetches fresh settings (hostname, role, color, …).
	rpc.reconnect();
}

async function addRepository(): Promise<void> {
	const repository = state.repository.trim();
	if (!repository) return;
	state.repoBusy = true;
	state.repoMessage = t("set.repo_importing", repository);
	const response = await run("repoMessage", () =>
		rpc.call<{ repositories: string[]; result: { files: number } }>("pipelines.repositories.add", { repository }),
	);
	state.repoBusy = false;
	if (!response) return;
	state.repositories = response.repositories;
	state.repository = "";
	state.repoMessage = t("set.repo_imported", response.result.files);
}

async function removeRepository(repository: string): Promise<void> {
	state.repoMessage = t("set.repo_removing", repository);
	const result = await run("repoMessage", () =>
		rpc.call<{ repositories: string[] }>("pipelines.repositories.remove", { repository }),
	);
	if (!result) return;
	state.repositories = result.repositories;
	state.repoMessage = t("set.repo_removed", repository);
}

async function updateAllRepositories(): Promise<void> {
	state.repoBusy = true;
	state.repoMessage = t("set.repo_updating_all");
	const response = await run("repoMessage", () =>
		rpc.call<{ results: { repository: string; files: number }[] }>("pipelines.repositories.updateAll"),
	);
	state.repoBusy = false;
	if (!response) return;
	const files = response.results.reduce((total, r) => total + r.files, 0);
	state.repoMessage = t("set.repo_updated_all", response.results.length, files);
}

function settingsCard(): m.Vnode {
	const tokenPlaceholder = !state.settings
		? t("set.token_ph_unchanged")
		: state.settings.hasRemoteToken
			? t("set.token_ph_configured")
			: t("set.token_ph_missing");
	return m(
		Card,
		m("p.muted", t("set.description")),
		form(
			{ onSubmit: save },
			field(t("set.hostname"), input(draft, "hostname", { pattern: HOSTNAME_PATTERN })),
			field(
				t("set.role"),
				select(
					draft,
					"role",
					options([
						["", t("set.role_keep")],
						["relay", t("role.relay")],
						["encoder", t("role.encoder")],
						["combined", t("role.combined")],
					]),
				),
			),
			brk(),
			field(t("set.color"), input(draft, "color", { type: "color" }, setHeaderColor)),
			brk(),
			field(t("set.remote_url"), input(draft, "remoteUrl", { placeholder: "wss://control.example/device" })),
			field(
				t("set.remote_token"),
				input(draft, "remoteToken", { type: "password", autocomplete: "off", placeholder: tokenPlaceholder }),
			),
			brk(),
			actions(button(t("set.save"), { type: "submit", disabled: state.saving })),
		),
		m("p.muted", { role: "status" }, state.message),
	);
}

function repositoriesCard(): m.Vnode {
	return m(
		Card,
		{ title: t("set.repos") },
		m("p.muted", t("set.repos_desc")),
		form(
			{ onSubmit: addRepository },
			field(
				t("set.repo_field"),
				input(state, "repository", { required: true, pattern: REPO_PATTERN, placeholder: "author/repository" }),
			),
			actions(
				button(t("set.repo_add"), { type: "submit", disabled: state.repoBusy }),
				button(t("set.repo_update_all"), {
					class: "secondary",
					disabled: state.repoBusy,
					onclick: () => void updateAllRepositories(),
				}),
			),
		),
		state.repositories.length
			? state.repositories.map((repository) =>
					m(
						"div.card-head",
						{ key: repository },
						m("code", repository),
						button(t("ui.remove"), { class: "danger", onclick: () => void removeRepository(repository) }),
					),
				)
			: m("p.muted", t("set.no_repos")),
		m("p.muted", { role: "status" }, state.repoMessage),
	);
}

const App: m.Component = {
	view: () =>
		m(
			Page,
			{
				title: [m("a", { href: "../", title: t("set.back") }, "←"), ` ${t("set.title")}`],
				headerRight: connectionBadge(state.connected),
			},
			settingsCard(),
			repositoriesCard(),
		),
};

mountPage(t("set.title"), App);
