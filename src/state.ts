/*
 * Persistent storage:
 *   config.json      permanent parameters only — device settings, encoder config,
 *                     the srtla target (+ scheduler options and interface
 *                     selection) and autostart. Stable key order, 2-space indent.
 *   in memory        live process state — running flags, pids, counters. Never
 *                     written to disk; a restarted process starts fresh.
 *
 * Modules mutate the merged in-memory `state` below and call `saveState()`,
 * which persists the permanent part to the config file.
 */
import { randomUUID } from "node:crypto";

import { DRY_RUN, DEVICE_CONFIG_FILE } from "./config";
import type { EncoderConfig, EncoderState } from "./encoder";
import { DEFAULT_LANGUAGE, asLanguage, setCurrentLanguage, type Language } from "./i18n";
import type { ModemConfig } from "./routing";
import type { SrtlaMode } from "./srtlaControl";
import type { SrtlaState } from "./srtla";
import { stableStringify } from "./util";

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
    /** UI language ("en" | "cs"); defaults to "en". */
    language?: Language;
}

/** srtla_send scheduler settings; applied live over the control socket and on every start. */
export interface SrtlaOptions { mode?: SrtlaMode; quality?: boolean; }

/** Last target of a combined-device stream (`stream.start`), kept for the UI to prefill. */
export interface StreamTarget { remoteHost: string; remotePort: string; listenPort: string; }

/** Last srtla_send target (`srtla.start`), kept after stop for prefill and autostart. */
export interface SrtlaTarget { listenPort: string; remoteHost: string; remotePort: string; }

/** srtla section of the config file: target, scheduler options, interface selection. */
export interface SrtlaConfig {
    listenPort: string;
    mode: SrtlaMode;
    quality: boolean;
    remoteHost: string;
    remotePort: string;
    selectedInterfaces: ModemConfig;
}

/** Permanent device parameters persisted to the config file (no process state). */
export interface DeviceConfig {
    autostart: boolean;
    color: string;
    hostname: string;
    language: Language;
    remoteUrl: string;
    role: string;
    uuid: string;
    remoteToken?: string;
    pipelineRepositories?: string[];
    encoder?: EncoderConfig;
    srtla: SrtlaConfig;
}

/** Merged in-memory view of config (persisted) + runtime (memory only). */
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
    settings: { uuid: randomUUID(), language: DEFAULT_LANGUAGE },
    selection: {},
    srtla: { running: false },
    encoder: { running: false },
});

const configFile = Bun.file(DEVICE_CONFIG_FILE);

// A fresh device (no config file) shows the setup wizard first.
export let setupRequired = !(await configFile.exists());

// ----------------------------------------------------------------------
// Projection between the merged in-memory state and the two files
// ----------------------------------------------------------------------

function projectConfig(s: PersistentState): DeviceConfig {
    const settings = s.settings ?? {};
    const target = s.srtlaTarget ?? s.stream ?? { listenPort: "", remoteHost: "", remotePort: "" };
    const options = s.srtlaOptions ?? {};
    const cfg: DeviceConfig = {
        autostart: !!s.autostart,
        color: settings.color ?? "#0f1115",
        hostname: settings.hostname ?? "",
        language: asLanguage(settings.language),
        remoteUrl: settings.remoteUrl ?? "",
        role: settings.role ?? "relay",
        uuid: settings.uuid ?? "",
        encoder: s.encoder.config,
        srtla: {
            listenPort: target.listenPort,
            mode: options.mode ?? "enhanced",
            quality: options.quality ?? false,
            remoteHost: target.remoteHost,
            remotePort: target.remotePort,
            selectedInterfaces: s.selection ?? {},
        },
    };
    if (settings.remoteToken) cfg.remoteToken = settings.remoteToken;
    if (settings.pipelineRepositories?.length) cfg.pipelineRepositories = settings.pipelineRepositories;
    return cfg;
}

function fromConfig(cfg: Partial<DeviceConfig> | null): PersistentState {
    const section: Partial<SrtlaConfig> = cfg?.srtla ?? {};
    const hasTarget = !!(section.listenPort || section.remoteHost || section.remotePort);
    const target = hasTarget
        ? { listenPort: section.listenPort ?? "", remoteHost: section.remoteHost ?? "", remotePort: section.remotePort ?? "" }
        : undefined;
    return {
        settings: {
            uuid: cfg?.uuid,
            hostname: cfg?.hostname ?? "",
            role: cfg?.role,
            remoteUrl: cfg?.remoteUrl ?? "",
            remoteToken: cfg?.remoteToken,
            color: cfg?.color,
            pipelineRepositories: cfg?.pipelineRepositories,
            language: cfg?.language,
        },
        selection: section.selectedInterfaces ?? {},
        srtla: { running: false },
        srtlaTarget: target,
        srtlaOptions: section.mode !== undefined || section.quality !== undefined
            ? { mode: section.mode, quality: section.quality }
            : undefined,
        encoder: { running: false, config: cfg?.encoder },
        stream: target,
        autostart: cfg?.autostart,
    };
}

// ----------------------------------------------------------------------
// Load and save
// ----------------------------------------------------------------------

async function loadState(): Promise<PersistentState> {
    if (await configFile.exists()) {
        return fromConfig(await configFile.json().catch(() => null));
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

let lastConfig = "";

/** Persist the permanent parameters; no-op when they have not changed. */
export async function saveState(): Promise<void> {
    notifyStateChange();
    if (DRY_RUN) return;
    const config = stableStringify(projectConfig(state));
    if (config === lastConfig) return;
    lastConfig = config;
    await Bun.write(DEVICE_CONFIG_FILE, config);
}

export async function completeSetup(): Promise<void> {
    setupRequired = false;
    await saveState();
}

/** Shared mutable state; modules mutate its fields and call `saveState()`. */
const state: PersistentState = await loadState();

// Hostnames change; the uuid is the device's permanent identity on the control server.
// It is auto-assigned (defaults()) / backfilled here, persisted, and never changes.
if (!state.settings?.uuid) {
    state.settings = { ...state.settings, uuid: randomUUID() };
    await saveState();
}
export { state };

// Older config files have no language; normalize so it is always present.
if (state.settings?.language === undefined) {
    state.settings = { ...state.settings, language: DEFAULT_LANGUAGE };
    await saveState();
}

// Seed the process-wide current language so t()/label() self-resolve to the
// device's saved UI language from the first log entry onward.
setCurrentLanguage(state.settings?.language);

/** UI language as persisted in settings (defaults to "en"). */
export function uiLanguage(): Language {
    return asLanguage(state.settings?.language);
}
