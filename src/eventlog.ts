/*
 * Persistent device event log (actions, process failures, autostart) shown in the web UI.
 * Kept in memory, capped at LOG_MAX entries and written to LOG_FILE shortly after changes.
 */
import { LOG_FILE } from "./config";
import type { LogEntry, LogLevel } from "./logMessages";

const LOG_MAX = 200;
const SAVE_DELAY_MS = 1_000;

async function loadLog(): Promise<LogEntry[]> {
    try {
        const data: unknown = await Bun.file(LOG_FILE).json();
        return Array.isArray(data) ? (data as LogEntry[]).slice(-LOG_MAX) : [];
    } catch {
        return [];
    }
}

const entries: LogEntry[] = await loadLog();
let nextId = Math.max(0, ...entries.map((e) => e.id)) + 1;
let saveTimer: ReturnType<typeof setTimeout> | null = null;

type Listener = (entry: LogEntry) => void;
const listeners = new Set<Listener>();

/** Subscribe to new / updated entries; returns an unsubscribe function. */
export function onLogEntry(listener: Listener): () => void {
    listeners.add(listener);
    return () => listeners.delete(listener);
}

/** Oldest first. */
export const logEntries = (): LogEntry[] => entries;

async function save(): Promise<void> {
    try {
        await Bun.write(LOG_FILE, JSON.stringify(entries));
    } catch (err: unknown) {
        console.warn(`Cannot write ${LOG_FILE}: ${err instanceof Error ? err.message : String(err)}`);
    }
}

function scheduleSave(): void {
    if (saveTimer) return;
    saveTimer = setTimeout(() => {
        saveTimer = null;
        void save();
    }, SAVE_DELAY_MS);
}

/** Write pending changes now (before exiting). */
export async function flushLog(): Promise<void> {
    if (!saveTimer) return;
    clearTimeout(saveTimer);
    saveTimer = null;
    await save();
}

/** Record an event; a repeat of the latest entry bumps its counter instead of adding one. */
export function logEvent(level: LogLevel, section: string, message: string): void {
    const at = Date.now();
    const last = entries.at(-1);
    let entry: LogEntry;
    if (last && last.level === level && last.section === section && last.message === message) {
        last.count = (last.count ?? 1) + 1;
        last.at = at;
        entry = last;
    } else {
        entry = { id: nextId++, at, level, section, message };
        entries.push(entry);
        if (entries.length > LOG_MAX) entries.splice(0, entries.length - LOG_MAX);
    }
    scheduleSave();
    for (const listener of listeners) listener(entry);
}
