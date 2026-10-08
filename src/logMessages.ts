/*
 * Event log entry shape and the log wording of API methods. Dependency-free so the
 * web UI can import it too.
 *
 * Sections and actions are canonical English constants (they are stored in log
 * entries and used for filtering); success wording is localized at creation time using
 * the current UI language. Display-time section localization uses label().
 */
import { t } from "./i18n";

/** Cap shared by every view of the event log (device, control server, UI). */
export const LOG_MAX = 200;

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

export interface MethodLog {
    section: string;
    action: string;                    // canonical English, for `<action> failed: <reason>`
    done: (p: Params) => string;       // resolves the current language at call time
}

const log = (section: string, action: string, done: string | ((p: Params) => string)): MethodLog => ({
    section,
    action,
    done: typeof done === "string" ? () => t(done) : done,
});

/** Methods that change something; read-only ones (status, *.list, …) are not logged. */
const METHOD_LOG: Record<string, MethodLog> = {
    "encoder.start": log("Encoder", "Start", "mlog.done.started"),
    "encoder.stop": log("Encoder", "Stop", "mlog.done.stopped"),
    "encoder.bitrate": log("Encoder", "Bitrate change", (p) => t("mlog.done.bitrate", p.minBitrate, p.maxBitrate)),
    "ceracoder.set": log("Encoder", "Bitrate control", "mlog.done.cera_settings"),
    "stream.start": log("Stream", "Start", "mlog.done.started"),
    "stream.stop": log("Stream", "Stop", "mlog.done.stopped"),
    "srtla.start": log("SRTLA", "Start", "mlog.done.started"),
    "srtla.stop": log("SRTLA", "Stop", "mlog.done.stopped"),
    "srtla.reload": log("SRTLA", "Reload", "mlog.done.reloaded"),
    "srtla.options": log("SRTLA", "Options update", (p) =>
        [
            p.mode !== undefined && t("mlog.done.mode", p.mode),
            p.quality !== undefined && t(p.quality ? "mlog.done.quality_on" : "mlog.done.quality_off"),
        ].filter(Boolean).join(", ")),
    "modems.select": log("Interfaces", "Bond selection", "mlog.done.bond_updated"),
    "modems.toggle": log("Interfaces", "Bond toggle", (p) => t("mlog.done.bond_toggled", p.iface)),
    reconfigure: log("Interfaces", "Reconfigure", "mlog.done.reconfigured"),
    "modems.enable": log("Modems", "Enable", (p) => t("mlog.done.modem_enabled", p.index)),
    "modems.disable": log("Modems", "Disable", (p) => t("mlog.done.modem_disabled", p.index)),
    "modems.connect": log("Modems", "Connect", (p) => t("mlog.done.modem_connected", p.index)),
    "modems.disconnect": log("Modems", "Disconnect", (p) => t("mlog.done.modem_disconnected", p.index)),
    "modems.reset": log("Modems", "Reset", (p) => t("mlog.done.modem_reset", p.index)),
    "autostart.set": log("Autostart", "Update", (p) => t(p.enabled ? "mlog.done.enabled" : "mlog.done.disabled")),
    "modules.enable": log("Modules", "Enable", (p) => t("mlog.done.module_enabled", p.id)),
    "modules.disable": log("Modules", "Disable", (p) => t("mlog.done.module_disabled", p.id)),
    "modules.configure": log("Modules", "Configuration", (p) => t("mlog.done.module_configured", p.id)),
};

/** Whether the device records this method in its event log. */
export const isLoggedMethod = (method: string): boolean => Object.hasOwn(METHOD_LOG, method);

/** Read-only methods still need wording for (browser-side) failures. */
const READ_LOG: Record<string, MethodLog> = {
    "pipelines.list": log("Pipelines", "Load", "mlog.done.loaded"),
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
    modules: "Modules",
};

/**
 * Log wording for an API method. `done` self-resolves the current language. On
 * failure the caller renders the localized "<action> failed: <reason>" (mlog.failed).
 */
export function methodLog(method: string): MethodLog {
    const own = (table: Record<string, MethodLog>) => (Object.hasOwn(table, method) ? table[method] : undefined);
    return own(METHOD_LOG) ?? own(READ_LOG)
        ?? log(SECTIONS[method.split(".")[0]] ?? method, method, () => t("mlog.done.generic", method));
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
    Modules: "mlog.section.modules",
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
    Configuration: "mlog.action.configuration",
    Create: "mlog.action.create",
    Delete: "mlog.action.delete",
    Activate: "mlog.action.activate",
    Update: "mlog.action.update",
};

/** Localize a canonical log section/action label for display (unknown labels pass through). */
export function label(name: string): string {
    const key = LABEL_KEYS[name];
    return key ? t(key) : name;
}
