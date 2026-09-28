/*
 * Event log entry shape and the log wording of API methods. Dependency-free so the
 * web UI can import it too.
 */
export type LogLevel = "info" | "warn" | "error";

export interface LogEntry {
    id: number;
    /** Set by the control server on entries it adds itself (device online / offline); the web UI
     *  uses "browser" for its own page-local entries. */
    origin?: "server" | "browser";
    at: number;           // last occurrence, ms since epoch
    level: LogLevel;
    section: string;
    message: string;
    count?: number;       // consecutive repeats folded into this entry
}

/** `event: "log"` payload: the full history when `reset`, otherwise new or updated entries. */
export interface LogEvent {
    reset?: boolean;
    entries: LogEntry[];
}

type Params = Record<string, unknown>;

interface MethodLog {
    section: string;
    action: string;                    // used in "<action> failed: <reason>"
    done: (p: Params) => string;
}

const m = (section: string, action: string, done: (p: Params) => string): MethodLog => ({ section, action, done });

/** Methods that change something; read-only ones (status, *.list, …) are not logged. */
const METHOD_LOG: Record<string, MethodLog> = {
    "encoder.start": m("Encoder", "Start", () => "Started"),
    "encoder.stop": m("Encoder", "Stop", () => "Stopped"),
    "encoder.bitrate": m("Encoder", "Bitrate change", (p) => `Bitrate set to ${p.maxBitrate} kbps`),
    "stream.start": m("Stream", "Start", () => "Started"),
    "stream.stop": m("Stream", "Stop", () => "Stopped"),
    "srtla.start": m("SRTLA", "Start", () => "Started"),
    "srtla.stop": m("SRTLA", "Stop", () => "Stopped"),
    "srtla.reload": m("SRTLA", "Reload", () => "Reloaded"),
    "srtla.options": m("SRTLA", "Options update", (p) =>
        [
            p.mode !== undefined && `Mode set to ${p.mode}`,
            p.quality !== undefined && `Quality scheduling ${p.quality ? "on" : "off"}`,
        ].filter(Boolean).join(", ")),
    "modems.select": m("Interfaces", "Bond selection", () => "Bond selection updated"),
    "modems.toggle": m("Interfaces", "Bond toggle", (p) => `${p.iface} toggled in bond`),
    reconfigure: m("Interfaces", "Reconfigure", () => "Reconfigured"),
    "modems.enable": m("Modems", "Enable", (p) => `Modem #${p.index} enabled`),
    "modems.disable": m("Modems", "Disable", (p) => `Modem #${p.index} disabled`),
    "modems.connect": m("Modems", "Connect", (p) => `Modem #${p.index} connected`),
    "modems.disconnect": m("Modems", "Disconnect", (p) => `Modem #${p.index} disconnected`),
    "modems.reset": m("Modems", "Reset", (p) => `Modem #${p.index} reset`),
    "autostart.set": m("Autostart", "Update", (p) => (p.enabled ? "Enabled" : "Disabled")),
};

const SECTIONS: Record<string, string> = {
    encoder: "Encoder", stream: "Stream", srtla: "SRTLA", modems: "Modems",
    interfaces: "Interfaces", pipelines: "Pipelines", autostart: "Autostart",
};

/** Whether the device records this method in its event log. */
export const isLoggedMethod = (method: string): boolean => Object.hasOwn(METHOD_LOG, method);

/** Read-only methods still need wording for (browser-side) failures. */
const READ_LOG: Record<string, MethodLog> = {
    "pipelines.list": m("Pipelines", "Load", () => "Loaded"),
};

export function methodLog(method: string): MethodLog {
    if (Object.hasOwn(METHOD_LOG, method)) return METHOD_LOG[method];
    if (Object.hasOwn(READ_LOG, method)) return READ_LOG[method];
    const prefix = method.split(".")[0];
    return m(SECTIONS[prefix] ?? prefix, method, () => `${method} done`);
}
