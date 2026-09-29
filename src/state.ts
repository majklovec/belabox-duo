import { DRY_RUN, STATE_FILE } from "./config";
import type { ModemConfig } from "./routing";
import type { EncoderState } from "./encoder";
import type { SrtlaState } from "./srtla";
import type { SrtlaMode } from "./srtlaControl";

/** Device settings that can be changed from the control UI and used on restart. */
export interface DeviceSettings {
    hostname?: string;
    role?: string;
    remoteUrl?: string;
    remoteToken?: string;
    color?: string;
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
    settings: {},
    selection: {},
    srtla: { running: false },
    encoder: { running: false },
});

async function loadState(): Promise<PersistentState> {
    const file = Bun.file(STATE_FILE);
    if (await file.exists()) {
        // Merge so state files from older versions gain new sections
        try { return { ...defaults(), ...((await file.json()) as Partial<PersistentState>) }; } catch {}
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

/** Shared mutable state; modules mutate its fields and call `saveState()`. */
export const state: PersistentState = await loadState();
