/*
 * obs-controller module: owns the ObsClient connection to the paired OBS
 * Studio and forwards its events into the belabox event stream (pushed with a
 * `module: "obs-controller"` tag). The obs.* API methods in methods.ts
 * dispatch their raw requests straight to this client.
 *
 * Also hosts the low-bitrate switcher sub-component (switcher.ts): its
 * engine runs on this module's lifecycle, drives scene changes through this
 * client, and its config nests under this module's settings slice.
 *
 * Self-contained: wire types are local; the only core edge is the bag.
 */
import { z } from "zod";
import {
	DEFAULT_EVENT_SUBSCRIPTIONS,
	EventSubscription,
	OBS_DISCONNECTED_EVENT,
	ObsClient,
	type ObsEvent,
	type ObsRequest,
	type ObsRequestBatch,
} from "../../obs-client";
import type { MCore, Mctx } from "./types";
import { bindSwitcherCore, startSwitcher, stopSwitcher, switcherServices } from "./switcher";

/** Core bag, filled at bind (discovery) and re-filled at start (a module may not import the core directly). */
let core: MCore;

// op5 events forwarded to the UI; the ones an operator dashboard reacts to.
// OBS v5 output events carry no "Current" prefix — they are StreamStateChanged /
// RecordStateChanged (the names the dashboards already listen for), unlike the
// scene/input events above. InputVolumeMeters feeds the card's VU meter,
// InputMute keeps its mute button honest.
const FORWARDED_EVENTS = [
	"CurrentProgramSceneChanged",
	"CurrentPreviewSceneChanged",
	"CurrentProgramSceneItemChanged",
	"CurrentTransitionChanged",
	"CurrentProgramInputChanged",
	"ActiveInputChanged",
	"SceneItemAdded",
	"SceneItemRemoved",
	"MediaInputPlaybackStateChanged",
	"MediaInputStateChanged",
	"StreamStateChanged",
	"RecordStateChanged",
	"InputVolumeMeters",
	"InputMute",
	"InputMuteStateChanged",
] as const;

const EVENT_SUBSCRIPTION_NAMES: Record<string, number> = {
	General: EventSubscription.General,
	Config: EventSubscription.Config,
	Scenes: EventSubscription.Scenes,
	Inputs: EventSubscription.Inputs,
	Transitions: EventSubscription.Transitions,
	Filters: EventSubscription.Filters,
	Outputs: EventSubscription.Outputs,
	SceneItems: EventSubscription.SceneItems,
	MediaInputs: EventSubscription.MediaInputs,
	Vendors: EventSubscription.Vendors,
	Ui: EventSubscription.Ui,
	InputVolumeMeters: EventSubscription.InputVolumeMeters,
	InputActiveStateChanged: EventSubscription.InputActiveStateChanged,
	InputShowStateChanged: EventSubscription.InputShowStateChanged,
	SceneItemTransformChanged: EventSubscription.SceneItemTransformChanged,
};

/** Case-insensitive: the map is keyed by upper-cased event names. */
const EVENT_SUBSCRIPTION_LOOKUP: Record<string, number> = Object.fromEntries(
	Object.entries(EVENT_SUBSCRIPTION_NAMES).map(([name, bit]) => [name.toUpperCase(), bit]),
);

let obsClient: ObsClient | null = null;

/** The live client, or a 409 asking the operator to enable the module. */
const requiredClient = (): ObsClient => {
	if (!obsClient) throw new core.ApiError("The obs-controller module is not running", 409);
	return obsClient;
};

/**
 * obs-controller services consumed by the core (the method dispatcher in
 * methods.ts) — exposed through the capability bus under "obs".
 */
export const obsServices = {
	/** The live client (null when the module is not running). */
	client: (): ObsClient | null => obsClient,
	/** OR of the event bits for the given names (case-insensitive; unknown names are skipped). */
	subscriptionMask(names: string[]): number {
		return names.reduce((acc, name) => acc | (EVENT_SUBSCRIPTION_LOOKUP[name.toUpperCase()] ?? EventSubscription.None), 0);
	},
	/**
	 * Apply persisted config fields (url / password / sceneEvents / enabled /
	 * switcherEnabled plus the nested `switcher` slice); caller saves the
	 * state. Only fields present in `config` are touched; an invalid switcher
	 * slice is a 400.
	 */
	configure(config: Record<string, unknown>): void {
		const obs = core.state.settings.modules?.["obs-controller"];
		if (!obs) return;
		if (typeof config.enabled === "boolean") obs.enabled = config.enabled;
		if (typeof config.obsUrl === "string") obs.obsUrl = config.obsUrl;
		if (typeof config.obsPassword === "string") obs.obsPassword = config.obsPassword;
		if (typeof config.sceneEvents === "boolean") obs.sceneEvents = config.sceneEvents;
		if (typeof config.switcherEnabled === "boolean") obs.switcherEnabled = config.switcherEnabled;
		if (config["switcher"] !== undefined) switcherServices.configure(config["switcher"] as Record<string, unknown>);
	},
};

const forward = (name: string, emit: Mctx["emit"]) =>
	(_data: Record<string, unknown>, event: ObsEvent) =>
		emit("obs.event", { eventType: name, eventIntent: event.eventIntent, eventData: event.eventData });

async function teardown(): Promise<void> {
	stopSwitcher();
	obsClient?.disconnect();
	obsClient = null;
}

export default {
	kind: "device",
	id: "obs-controller",
	title: "OBS",
	configSchema: z.object({
		enabled: z.boolean().optional(),
		obsUrl: z.string().optional(),
		obsPassword: z.string().optional(),
		sceneEvents: z.boolean().optional(),
		switcherEnabled: z.boolean().optional(),
		switcher: z.unknown().optional(),
	}).passthrough(),
	secretFields: ["obsPassword"],
	bind(c: MCore) {
		core = c;
		bindSwitcherCore(c);
	},
	async start(ctx: Mctx) {
		core = ctx.core;
		await teardown();
		const cfg = ctx.config;
		if (cfg["enabled"] !== true) return;
		if (typeof cfg["obsUrl"] !== "string" || !cfg["obsUrl"]) {
			ctx.log("obs-controller", "enabled but no obsUrl set; module idle");
			return;
		}
		const obsPassword = cfg["obsPassword"];
		obsClient = new ObsClient({
			url: cfg["obsUrl"],
			...(obsPassword ? { password: obsPassword as string } : {}),
			// The VU meter needs the InputVolumeMeters bit (absent from the defaults);
			// InputMute rides in on the Inputs bit below.
			eventSubscriptions:
				cfg["sceneEvents"] === true
					? DEFAULT_EVENT_SUBSCRIPTIONS | EventSubscription.InputVolumeMeters
					: EventSubscription.None,
			log: (msg, ...rest) => ctx.log("obs-controller", [msg, ...rest].map(String).join(" ")),
		});
		for (const name of FORWARDED_EVENTS) obsClient.on(name, forward(name, ctx.emit));
		// Synthetic drop event (clearly marked as non-standard by the client)
		obsClient.on(OBS_DISCONNECTED_EVENT, () => ctx.emit("obs.event", { disconnected: true }));
		// The low-bitrate switcher sub-component: runs on this module's
		// lifecycle, scene-switches through this client (no extra websocket),
		// and only while its OBS-level master switch is on.
		if (ctx.config["switcherEnabled"] === true) startSwitcher(ctx, () => obsClient);
	},
	async stop() {
		await teardown();
	},
	methods: ["obs.request", "obs.requestBatch", "obs.setEventSubscriptions"] as const,
	events: ["obs.event", "lowBitrateSwitcher.state"] as const,
	async status() {
		// The switcher's live state in the status payload (null = not running)
		return { lowBitrateSwitcher: switcherServices.status() };
	},
	async dispatch(method: string, params: Record<string, unknown>) {
		switch (method) {
			case "obs.request": {
				const request: ObsRequest = {
					requestType: String(params["requestType"]),
					requestId: String(params["requestId"]),
					requestData: params["requestData"] as Record<string, unknown>,
				};
				// op7 passthrough: the obs-websocket v5 response `d`, statuses unmapped
				return requiredClient().sendRequest(request);
			}
			case "obs.requestBatch": {
				// op9 passthrough: the obs-websocket v5 batch response `d`
				return requiredClient().sendBatch(params as unknown as ObsRequestBatch);
			}
			case "obs.setEventSubscriptions": {
				const intents = Number(params["eventSubscriptions"]);
				requiredClient().setEventSubscriptions(intents);
				return { ok: true, eventSubscriptions: intents };
			}
			default:
				throw new Error(`unknown method ${method}`);
		}
	},
	services: {
		capabilities: {
			"obs.controller": obsServices,
		},
	},
};
