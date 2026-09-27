import { DRY_RUN, STATE_FILE } from "./config";
import type { ModemConfig } from "./routing";
import type { SrtlaState } from "./srtla";

export interface PersistentState { selection: ModemConfig; srtla: SrtlaState; }

async function loadState(): Promise<PersistentState> {
    const file = Bun.file(STATE_FILE);
    if (await file.exists()) {
        try { return (await file.json()) as PersistentState; } catch {}
    }
    return { selection: {}, srtla: { running: false } };
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
