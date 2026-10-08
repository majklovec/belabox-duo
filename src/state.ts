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

import { CONFIG_EXISTS, CONFIG_FILE, DRY_RUN, INITIAL_CONFIG } from "./config";
import { defaultLowBitrateSwitcherConfig, type CeraConfig, type EncoderConfig, type EncoderState, type LowBitrateSwitcherConfig, type SrtlaState } from "../modules/types";
import { normalizeSwitcherConfig } from "../modules/obs-controller/switcher-engine";
import { writeFileAtomic } from "./files";
import { asLanguage, DEFAULT_LANGUAGE, type Language, setCurrentLanguage } from "./i18n";
import type { ModemConfig } from "./routing";
import type { SrtlaMode } from "./srtlaControl";
import { stableStringify } from "./util";
import { DEFAULT_COLOR, modulesForRole, type Role } from "./validate";

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
    /** Per-module settings (relay/encoder/obs-controller). */
    modules?: ModulesState;
}

/** srtla_send scheduler settings; applied live over the control socket and on every start. */
export interface SrtlaOptions { mode?: SrtlaMode; quality?: boolean; }

/** Result of persisting+applying scheduler settings (`applied` is false until the next start). */
export interface SrtlaOptionsResult { options: SrtlaOptions; applied: boolean; }

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

/** New-style per-module settings (config key "modules"). */
export interface ObsModuleConfig {
    enabled: boolean;
    obsUrl: string;
    obsPassword: string;
    sceneEvents: boolean;
    /** Master switch for the low-bitrate switcher this module hosts (OBS must run for it). */
    switcherEnabled: boolean;
    /** The low-bitrate switcher sub-component this module hosts. */
    switcher: LowBitrateSwitcherConfig;
}
/** All module keys the registry knows, and their on-disk shape. */
export const ALL_MODULES = ["relay", "encoder", "obs-controller"] as const;

/**
 * Registry module ID → persisted settings key. `srtla` reads the legacy
 * "relay" key. Kept here so methods and the registry both resolve the same
 * persisted slice.
 */
export const MODULE_CONFIG_KEYS: Record<string, string> = {
	"encoder": "encoder",
	"srtla": "relay",
	"modems": "modems",
	"obs-controller": "obs-controller",
};

export type ModuleId = (typeof ALL_MODULES)[number];

export const OBS_MODULE = "obs-controller" as const;
export interface ModulesState {
    relay: { enabled: boolean };
    encoder: { enabled: boolean };
    "obs-controller": ObsModuleConfig;
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
    modules?: ModulesState;
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
    if (settings.modules) cfg.modules = settings.modules;
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
            // Backfill: pre-module configs get the role's preset modules
            // enabled; modules added later get their defaults merged in.
            modules: backfillModules(cfg?.modules, cfg?.role),
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

/**
 * Default per-module settings for configs written before the module system:
 * the role's pre-selected modules are enabled, all others disabled. The relay
 * and encoder modules mirror the legacy flat config (targets/URLs live on the
 * existing settings fields, so only `enabled` is carried here).
 */
export function defaultModules(role?: Role): ModulesState {
    const on = new Set(role ? modulesForRole(role) : []);
    return {
        relay: { enabled: on.has("relay") },
        encoder: { enabled: on.has("encoder") },
        "obs-controller": { enabled: false, obsUrl: "", obsPassword: "", sceneEvents: true, switcherEnabled: false, switcher: defaultLowBitrateSwitcherConfig() },
    };
}

/**
 * Stored module maps predate newer settings (e.g. the switcher slice); fill
 * missing keys with the defaults for the role so the map always has the
 * full shape. Stored values win over the defaults. Configs written before
 * the switcher merged into obs-controller carry it as a top-level modules
 * key — move it into the obs slice once, here.
 */
function backfillModules(stored: Partial<ModulesState> | undefined, role?: Role): ModulesState {
    if (!stored) return defaultModules(role);
    // A pre-merge top-level switcher slice is promoted into the obs one, not copied across
    const { lowBitrateSwitcher: legacy, ...rest } =
        stored as Partial<ModulesState> & { lowBitrateSwitcher?: Record<string, unknown> };
    const out: ModulesState = { ...defaultModules(role), ...rest };
    const storedObs = rest["obs-controller"] as { switcherEnabled?: boolean } | undefined;
    // Pre-merge configs enabled the switcher under the top-level slice's own flag
    const legacyEnabled =
        typeof (legacy as { enabled?: unknown } | undefined)?.enabled === "boolean"
            ? (legacy as { enabled: boolean }).enabled
            : undefined;
    const obs = out["obs-controller"];
    // A stored obs slice may predate the switcher slice — the type requires it.
    if (!obs.switcher) obs.switcher = defaultLowBitrateSwitcherConfig();
    if (legacy) {
        const migrated = normalizeSwitcherConfig(legacy);
        if (migrated) out["obs-controller"] = { ...obs, switcher: migrated };
    }
    // One-time migration: the switcher's own `enabled` flag moves up to the
    // OBS-level `switcherEnabled` parameter (legacy top-level included). Only
    // when the OBS slice never stored `switcherEnabled` explicitly does the
    // migrated `enabled` win — a stored value is kept verbatim.
    const o = out["obs-controller"] as { switcherEnabled?: boolean; switcher: LowBitrateSwitcherConfig };
    if (storedObs?.switcherEnabled === undefined)
        o.switcherEnabled = legacyEnabled ?? ((o.switcher as { enabled?: boolean }).enabled === true);
    delete (o.switcher as { enabled?: boolean }).enabled;
    return out;
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
    // A fresh device had no config, so its in-memory state has no modules yet:
    // seed them from the role picked in the wizard.
    if (!state.settings.modules) {
        state.settings.modules = defaultModules(state.settings.role);
    }
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
