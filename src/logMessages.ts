/*
 * Event log entry shape and the log wording of API methods. Dependency-free so the
 * web UI can import it too.
 *
 * Sections and actions are canonical English constants (they are stored in log
 * entries and used for filtering); success wording is localized at creation time using
 * the current UI language. Display-time section localization uses label().
 */
import { t } from "./i18n";

export type LogLevel = "info" | "warn" | "error";

export interface LogEntry {
    id: number;
    /** Set by the control server on entries it adds itself (device online / offline); the web UI
     *  uses "browser" for its own page-local entries. */
    origin?: "server" | "browser";
    at: number;           // last occurrence, ms since epoch
    level: LogLevel;
    section: string;      // canonical English section name
    message: string;      // localized at creation time
    count?: number;       // consecutive repeats folded into this entry
}

/** `event: "log"` payload: the full history when `reset`, otherwise new or updated entries. */
export interface LogEvent {
    reset?: boolean;
    entries: LogEntry[];
}

type Params = Record<string, unknown>;
type Done = (p: Params) => string;

interface MethodLogDef { section: string; action: string; done: Done; }

/** Methods that change something; read-only ones (status, *.list, …) are not logged. */
const METHOD_LOG: Record<string, MethodLogDef> = {
    "encoder.start": { section: "Encoder", action: "Start", done: (_p) => t("mlog.done.started") },
    "encoder.stop": { section: "Encoder", action: "Stop", done: (_p) => t("mlog.done.stopped") },
    "encoder.bitrate": { section: "Encoder", action: "Bitrate change", done: (p) => t("mlog.done.bitrate", p.maxBitrate) },
    "stream.start": { section: "Stream", action: "Start", done: (_p) => t("mlog.done.started") },
    "stream.stop": { section: "Stream", action: "Stop", done: (_p) => t("mlog.done.stopped") },
    "srtla.start": { section: "SRTLA", action: "Start", done: (_p) => t("mlog.done.started") },
    "srtla.stop": { section: "SRTLA", action: "Stop", done: (_p) => t("mlog.done.stopped") },
    "srtla.reload": { section: "SRTLA", action: "Reload", done: (_p) => t("mlog.done.reloaded") },
    "srtla.options": { section: "SRTLA", action: "Options update", done: (p) =>
        [
            p.mode !== undefined && t("mlog.done.mode", p.mode),
            p.quality !== undefined && t(p.quality ? "mlog.done.quality_on" : "mlog.done.quality_off"),
        ].filter(Boolean).join(", ") },
    "modems.select": { section: "Interfaces", action: "Bond selection", done: (_p) => t("mlog.done.bond_updated") },
    "modems.toggle": { section: "Interfaces", action: "Bond toggle", done: (p) => t("mlog.done.bond_toggled", p.iface) },
    reconfigure: { section: "Interfaces", action: "Reconfigure", done: (_p) => t("mlog.done.reconfigured") },
    "modems.enable": { section: "Modems", action: "Enable", done: (p) => t("mlog.done.modem_enabled", p.index) },
    "modems.disable": { section: "Modems", action: "Disable", done: (p) => t("mlog.done.modem_disabled", p.index) },
    "modems.connect": { section: "Modems", action: "Connect", done: (p) => t("mlog.done.modem_connected", p.index) },
    "modems.disconnect": { section: "Modems", action: "Disconnect", done: (p) => t("mlog.done.modem_disconnected", p.index) },
    "modems.reset": { section: "Modems", action: "Reset", done: (p) => t("mlog.done.modem_reset", p.index) },
    "autostart.set": { section: "Autostart", action: "Update", done: (p) =>
        t(p.enabled ? "mlog.done.enabled" : "mlog.done.disabled") },
};

/** Whether the device records this method in its event log. */
export const isLoggedMethod = (method: string): boolean => Object.hasOwn(METHOD_LOG, method);

/** Read-only methods still need wording for (browser-side) failures. */
const READ_LOG: Record<string, MethodLogDef> = {
    "pipelines.list": { section: "Pipelines", action: "Load", done: (_p) => t("mlog.done.loaded") },
};

/** Section for unknown methods, by prefix. */
const SECTIONS: Record<string, string> = {
    encoder: "Encoder",
    stream: "Stream",
    srtla: "SRTLA",
    modems: "Modems",
    interfaces: "Interfaces",
    pipelines: "Pipelines",
    autostart: "Autostart",
};

export interface MethodLog {
    section: string;
    action: string;                    // canonical English, for `<action> failed: <reason>`
    done: (p: Params) => string;       // resolves the current language at call time
}

/**
 * Log wording for an API method. `done` self-resolves the current language. On
 * failure the caller renders the localized "<action> failed: <reason>" (mlog.failed).
 */
export function methodLog(method: string): MethodLog {
    const known = METHOD_LOG[method] ?? READ_LOG[method];
    const def = known ?? {
        section: SECTIONS[method.split(".")[0]] ?? method,
        action: method,
        done: (_p: Params) => t("mlog.done.generic", method),
    };
    return { section: def.section, action: def.action, done: (p) => def.done(p) };
}

/** Canonical label (section / action) → i18n key. Labels are English constants so log
 *  entries keep stable, filterable values; the UI localizes them at display time. */
const LABEL_KEYS: Record<string, string> = {
    // sections
    Encoder: "mlog.section.encoder",
    Modems: "dev.card.modems",
    Interfaces: "dev.card.interfaces",
    Pipelines: "mlog.section.pipelines",
    Autostart: "ui.autostart",
    Settings: "mlog.section.settings",
    Service: "mlog.section.service",
    Connection: "mlog.section.connection",
    Device: "mgmt.th.device",
    SRTLA: "dev.card.srtla",
    Stream: "mgmt.th.stream",
    Setup: "mlog.section.setup",
    Unknown: "mlog.section.unknown",
    // actions
    Start: "ui.start",
    Stop: "ui.stop",
    Reload: "ui.reload",
    Enable: "ui.enable",
    Disable: "ui.disable",
    Connect: "ui.connect",
    Disconnect: "ui.disconnect",
    Reset: "ui.reset",
    Reconfigure: "ui.reconfigure",
    "Bitrate change": "mlog.action.bitrate",
    "Options update": "mlog.action.options",
    "Bond selection": "mlog.action.bond_selection",
    "Bond toggle": "mlog.action.bond_toggle",
    "Load": "mlog.action.load",
    Update: "mlog.action.update",
};

/** Localize a canonical log section/action label for display (unknown labels pass through). */
export function label(name: string): string {
    const key = LABEL_KEYS[name];
    return key ? t(key) : name;
}
