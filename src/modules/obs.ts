/*
 * obs-controller module: owns the ObsClient connection to the paired OBS
 * Studio and forwards its events into the belabox event stream (pushed with a
 * `module: "obs-controller"` tag). The obs.* API methods in methods.ts delegate
 * their requests straight to this client.
 */
import {
    ObsClient,
    type ObsEvent,
    OBS_DISCONNECTED_EVENT,
    DEFAULT_EVENT_SUBSCRIPTIONS,
    EventSubscription,
} from "./obs-client";
import { pushModuleEvent } from "../push";
import { OBS_MODULE, state } from "../state";

// op5 events forwarded to the UI; the ones an operator dashboard reacts to.
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
    "CurrentStreamStateChanged",
    "CurrentRecordingStateChanged",
] as const;

let obsClient: ObsClient | null = null;

/** The live client (null when the module is not running). */
export const obsClientFor = (): ObsClient | null => obsClient;

export function startObsModule(): void {
    stopObsModule();
    const cfg = state.settings.modules?.["obs-controller"];
    if (!cfg?.enabled) return;
    if (!cfg.obsUrl) {
        console.log("[obs-controller] enabled but no obsUrl set; module idle");
        return;
    }
    obsClient = new ObsClient({
        url: cfg.obsUrl,
        ...(cfg.obsPassword ? { password: cfg.obsPassword } : {}),
        eventSubscriptions: cfg.sceneEvents ? DEFAULT_EVENT_SUBSCRIPTIONS : EventSubscription.None,
        log: (msg, ...rest) => console.log("[obs-controller]", msg, ...rest),
    });
    for (const name of FORWARDED_EVENTS) {
        obsClient.on(name, forward(name));
    }
    // Synthetic drop event (clearly marked as non-standard by the client)
    obsClient.on(OBS_DISCONNECTED_EVENT, () => pushModuleEvent("obs.event", { disconnected: true }, OBS_MODULE));
}

const forward = (name: string) =>
    (_data: Record<string, unknown>, event: ObsEvent) =>
        pushModuleEvent("obs.event", { eventType: name, eventIntent: event.eventIntent, eventData: event.eventData }, OBS_MODULE);

export function stopObsModule(): void {
    obsClient?.disconnect();
    obsClient = null;
}

/** Client config changes (url / password / sceneEvents) require a reconnect. */
export function restartObsModule(): void {
    if (state.settings.modules?.["obs-controller"]?.enabled) startObsModule();
}
