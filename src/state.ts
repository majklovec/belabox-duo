/*
 * Persistent storage:
 *   config.json      permanent parameters only — device settings, encoder config,
 *                     the srtla target (+ scheduler options), the modems bonding
 *                     selection and autostart. Stable key order, 2-space indent.
 *   in memory        live process state — running flags, pids, counters. Never
 *                     written to disk; a restarted process starts fresh.
 *
 * Modules mutate the merged in-memory `state` below and call `saveState()`,
 * which persists the permanent part to the config file.
 */
import { randomUUID } from "node:crypto";

import type { CeraConfig } from "./encoders/ceracoder";
import { CONFIG_EXISTS, CONFIG_FILE, DRY_RUN, INITIAL_CONFIG } from "./config";
import type { EncoderConfig, EncoderState } from "./encoder";
import { writeFileAtomic } from "./files";
import { asLanguage, DEFAULT_LANGUAGE, type Language, setCurrentLanguage } from "./i18n";
import type { ModemConfig } from "./routing";
import type { SrtlaMode } from "./srtlaControl";
import type { SrtlaState } from "./srtla";
import { stableStringify } from "./util";
import { DEFAULT_COLOR, type Role } from "./validate";

/** Device settings that can be changed from the control UI and used on restart. */
export interface DeviceSettings {
    /** Stable identity; the device registers with the control server under this uuid */
    uuid?: string;
    hostname?: string;
    role?: Role;
    remoteUrl?: string;
    remoteToken?: string;
    color?: string;
    pipelineRepositories?: string[];
    /** UI language (see LANGUAGE_INFO in i18n.ts); defaults to "en". */
    language?: Language;
}

/** srtla_send scheduler settings; applied live over the control socket and on every start. */
export interface SrtlaOptions { mode?: SrtlaMode; quality?: boolean; }

/** Last target of a combined-device stream (`stream.start`), kept for the UI to prefill. */
export interface StreamTarget { remoteHost: string; remotePort: string; listenPort: string; }

/** Last srtla_send target (`srtla.start`), kept after stop for prefill and autostart. */
export interface SrtlaTarget { listenPort: string; remoteHost: string; remotePort: string; }

/** srtla section of the config file: target and scheduler options. */
export interface SrtlaConfig {
    listenPort: string;
    mode: SrtlaMode;
    quality: boolean;
    remoteHost: string;
    remotePort: string;
}

/** Permanent device parameters persisted to the config file (no process state). */
export interface DeviceConfig {
    autostart: boolean;
    color: string;
    hostname: string;
    language: Language;
    remoteUrl: string;
    role: Role;
    uuid: string;
    remoteToken?: string;
    pipelineRepositories?: string[];
    encoder?: EncoderConfig;
    /** ceracoder bitrate-control settings (only with the ceracoder encoder). */
    ceracoder?: CeraConfig;
    /** Bonding selection (old modems.json). */
    modems?: ModemConfig;
    srtla: SrtlaConfig;
}

/** Merged in-memory view of config (persisted) + runtime (memory only). */
export interface PersistentState {
    settings: DeviceSettings;
    selection: ModemConfig;
    srtla: SrtlaState;
    srtlaTarget?: SrtlaTarget;
    srtlaOptions?: SrtlaOptions;
    encoder: EncoderState;
    ceracoder?: CeraConfig;   // only with the ceracoder encoder
    stream?: StreamTarget;
    autostart?: boolean;      // resume the last stream when the service starts
}

// A fresh device (no config file) shows the setup wizard first.
export let setupRequired = !CONFIG_EXISTS;

// ----------------------------------------------------------------------
// Projection between the merged in-memory state and the two files
// ----------------------------------------------------------------------

function projectConfig(s: PersistentState): DeviceConfig {
    const { settings } = s;
    const target = s.srtlaTarget ?? s.stream ?? { listenPort: "", remoteHost: "", remotePort: "" };
    const options = s.srtlaOptions ?? {};
    const cfg: DeviceConfig = {
        autostart: !!s.autostart,
        color: settings.color ?? DEFAULT_COLOR,
        hostname: settings.hostname ?? "",
        language: asLanguage(settings.language),
        remoteUrl: settings.remoteUrl ?? "",
        role: settings.role ?? "relay",
        uuid: settings.uuid ?? "",
        encoder: s.encoder.config,
        modems: s.selection ?? {},
        srtla: {
            listenPort: target.listenPort,
            mode: options.mode ?? "enhanced",
            quality: options.quality ?? false,
            remoteHost: target.remoteHost,
            remotePort: target.remotePort,
        },
    };
    if (settings.remoteToken) cfg.remoteToken = settings.remoteToken;
    if (settings.pipelineRepositories?.length) cfg.pipelineRepositories = settings.pipelineRepositories;
    if (s.ceracoder) cfg.ceracoder = s.ceracoder;
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
        selection: cfg?.modems ?? {},
        srtla: { running: false },
        srtlaTarget: target,
        srtlaOptions: section.mode !== undefined || section.quality !== undefined
            ? { mode: section.mode, quality: section.quality }
            : undefined,
        encoder: { running: false, config: cfg?.encoder },
        ceracoder: cfg?.ceracoder,
        stream: target,
        autostart: cfg?.autostart,
    };
}

// ----------------------------------------------------------------------
// Change notification and save
// ----------------------------------------------------------------------
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
    await writeFileAtomic(CONFIG_FILE, config);
}

export async function completeSetup(): Promise<void> {
    setupRequired = false;
    await saveState();
}

/** Shared mutable state; modules mutate its fields and call `saveState()`. */
export const state: PersistentState = CONFIG_EXISTS
    ? fromConfig(INITIAL_CONFIG as Partial<DeviceConfig> | null)
    : { settings: {}, selection: {}, srtla: { running: false }, encoder: { running: false } };

// Hostnames change; the uuid is the device's permanent identity on the control server.
// It is auto-assigned here (backfilled into older config files) and never changes.
// Older config files have no language either; normalize so it is always present.
// A fresh device keeps both in memory only, so the setup wizard still runs.
{
    const backfill = CONFIG_EXISTS && (!state.settings.uuid || state.settings.language === undefined);
    state.settings.uuid ||= randomUUID();
    state.settings.language ??= DEFAULT_LANGUAGE;
    if (backfill) await saveState();
}

// Seed the process-wide current language so t()/label() self-resolve to the
// device's saved UI language from the first log entry onward.
setCurrentLanguage(state.settings.language);

/** UI language as persisted in settings (defaults to "en"). */
export const uiLanguage = (): Language => asLanguage(state.settings.language);
