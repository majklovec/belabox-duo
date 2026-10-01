import { randomUUID } from "node:crypto";
import { DRY_RUN, STATE_FILE } from "./config";
import type { ModemConfig } from "./routing";
import type { EncoderState } from "./encoder";
import type { SrtlaState } from "./srtla";
import type { SrtlaMode } from "./srtlaControl";

/** Device settings that can be changed from the control UI and used on restart. */
export interface DeviceSettings {
    /** Stable identity; the device registers with the control server under this uuid */
    uuid?: string;
    hostname?: string;
    role?: string;
    remoteUrl?: string;
    remoteToken?: string;
    color?: string;
    pipelineRepositories?: string[];
}

/** srtla_send scheduler settings; applied live over the control socket and on every start. */
export interface SrtlaOptions { mode?: SrtlaMode; quality?: boolean; }

/** Last target of a combined-device stream (`stream.start`), kept for the UI to prefill. */
export interface StreamTarget { remoteHost: string; remotePort: string; listenPort: string; }

/** Last srtla_send target (`srtla.start`), kept after stop for prefill and autostart. */
export interface SrtlaTarget { listenPort: string; remoteHost: string; remotePort: string; }

export interface PersistentState {
    settings?: DeviceSettings;
    selection: ModemConfig;
    srtla: SrtlaState;
    srtlaTarget?: SrtlaTarget;
    srtlaOptions?: SrtlaOptions;
    encoder: EncoderState;
    stream?: StreamTarget;
    autostart?: boolean;      // resume the last stream when the service starts
}

const defaults = (): PersistentState => ({
    settings: { uuid: randomUUID() },
    selection: {},
    srtla: { running: false },
    encoder: { running: false },
});

const stateFile = Bun.file(STATE_FILE);
export let setupRequired = !(await stateFile.exists());

async function loadState(): Promise<PersistentState> {
    if (!setupRequired) {
        // Merge so state files from older versions gain new sections
        try { return { ...defaults(), ...((await stateFile.json()) as Partial<PersistentState>) }; } catch {}
    }
    return defaults();
}

type ChangeListener = () => void;
const listeners = new Set<ChangeListener>();

/** Subscribe to state / uplink changes; returns an unsubscribe function. */
export function onStateChange(listener: ChangeListener): () => void {
    listeners.add(listener);
    return () => listeners.delete(listener);
}

export function notifyStateChange(): void {
    for (const listener of listeners) listener();
}

export async function saveState(): Promise<void> {
    notifyStateChange();
    if (DRY_RUN) return;
    await Bun.write(STATE_FILE, JSON.stringify(state, null, 2));
}

export async function completeSetup(): Promise<void> {
    setupRequired = false;
    await saveState();
}

/** Shared mutable state; modules mutate its fields and call `saveState()`. */
const state: PersistentState = await loadState();

// Hostnames change; the uuid is the device's permanent identity on the control server.
// It is auto-assigned (defaults() / backfill for older state files), persisted here
// and never changes afterwards.
if (!state.settings?.uuid) {
    state.settings = { ...state.settings, uuid: randomUUID() };
    if (!DRY_RUN) await Bun.write(STATE_FILE, JSON.stringify(state, null, 2));
}

export { state };
