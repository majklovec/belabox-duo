/*
 * obs-controller module: owns the ObsClient connection to the paired OBS
 * Studio and forwards its events into the belabox event stream (pushed with a
 * `module: "obs-controller"` tag). The obs.* API methods in methods.ts
 * dispatch their raw requests straight to this client.
 */
import {
	DEFAULT_EVENT_SUBSCRIPTIONS,
	EventSubscription,
	OBS_DISCONNECTED_EVENT,
	ObsClient,
	type ObsEvent,
	type ObsRequest,
	type ObsRequestBatch,
} from "../../obs-client";
import { ApiError } from "../../src/params";
import { state } from "../../src/state";
import type { DeviceModule, ModuleContext } from "../types";

// op5 events forwarded to the UI; the ones an operator dashboard reacts to.
// OBS v5 output events carry no "Current" prefix — they are StreamStateChanged /
// RecordStateChanged (the names the dashboards already listen for), unlike the
// scene/input events above.
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
	if (!obsClient) throw new ApiError("The obs-controller module is not running", 409);
	return obsClient;
};

/**
 * obs-controller services consumed by the core (the method dispatcher in
 * methods.ts) — the registry is the core's only door into module code.
 */
export const obsServices = {
	/** The live client (null when the module is not running). */
	client: (): ObsClient | null => obsClient,
	/** OR of the event bits for the given names (case-insensitive; unknown names are skipped). */
	subscriptionMask(names: string[]): number {
		return names.reduce((acc, name) => acc | (EVENT_SUBSCRIPTION_LOOKUP[name.toUpperCase()] ?? EventSubscription.None), 0);
	},
	/** Apply persisted config fields (url / password / sceneEvents / enabled); caller saves the state. */
	configure(config: Record<string, unknown>): void {
		const obs = state.settings.modules?.["obs-controller"];
		if (!obs) return;
		if (typeof config.enabled === "boolean") obs.enabled = config.enabled;
		if (typeof config.obsUrl === "string") obs.obsUrl = config.obsUrl;
		if (typeof config.obsPassword === "string") obs.obsPassword = config.obsPassword;
		if (typeof config.sceneEvents === "boolean") obs.sceneEvents = config.sceneEvents;
	},
};

const forward = (name: string, emit: ModuleContext["emit"]) =>
	(_data: Record<string, unknown>, event: ObsEvent) =>
		emit("obs.event", { eventType: name, eventIntent: event.eventIntent, eventData: event.eventData });

export const obsControllerModule: DeviceModule = {
	id: "obs-controller",
	title: "OBS",
	configSchema: null,
	secretFields: ["obsPassword"],
	async start(ctx: ModuleContext) {
		await obsControllerModule.stop();
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
			eventSubscriptions: cfg["sceneEvents"] === true ? DEFAULT_EVENT_SUBSCRIPTIONS : EventSubscription.None,
			log: (msg, ...rest) => ctx.log("obs-controller", [msg, ...rest].map(String).join(" ")),
		});
		for (const name of FORWARDED_EVENTS) obsClient.on(name, forward(name, ctx.emit));
		// Synthetic drop event (clearly marked as non-standard by the client)
		obsClient.on(OBS_DISCONNECTED_EVENT, () => ctx.emit("obs.event", { disconnected: true }));
	},
	async stop() {
		obsClient?.disconnect();
		obsClient = null;
	},
	methods: ["obs.request", "obs.requestBatch", "obs.setEventSubscriptions"] as const,
	events: ["obs.event"] as const,
	async dispatch(method, params) {
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
};
