/*
 * Role-level streaming: the combined "srtla_send + belacoder" start/stop and
 * autostart (resume the last stream when the service starts, like belaUI).
 *
 * What autostart starts depends on the role, always from the last settings used:
 *   relay     srtla_send with the last srtla.start target
 *   encoder   belacoder with the last encoder config
 *   combined  srtla_send + belacoder with the last stream.start target / config
 */
import { ROLE } from "./config";
import type { EncoderConfig } from "../public/types";
import { encoderServices, srtlaServices } from "./services";
import { logEvent } from "./eventlog";
import { t } from "./i18n";
import { saveState, type StreamTarget, state } from "./state";
import { errorMessage } from "./util";

const AUTOSTART_RETRY_MS = 5_000;

/** Bring up srtla_send (reusing it if already aimed at the same target), then belacoder into it. */
export async function startCombined(target: StreamTarget, cfg: EncoderConfig): Promise<void> {
    if (encoderServices.encoder().status().running) throw new Error("already streaming");
    // Persist both halves of the requested stream before validation/startup.
    // srtlaTarget is the canonical target the config file is projected from;
    // stream mirrors it for the UI and for autostart.
    state.srtlaTarget = target;
    state.stream = target;
    state.encoder = { running: false, config: cfg };
    await saveState();
    await encoderServices.encoder().validate(cfg);   // fail before touching srtla_send

    const { listenPort, remoteHost, remotePort } = target;
    const s = srtlaServices.srtlaStatus();
    if (s.running && (s.listenPort !== listenPort || s.remoteHost !== remoteHost || s.remotePort !== remotePort)) {
        await srtlaServices.stopSrtla();
    }
    if (!srtlaServices.srtlaStatus().running) await srtlaServices.startSrtla(listenPort, remoteHost, remotePort);

    try {
        await encoderServices.encoder().start({ ...cfg, host: "127.0.0.1", port: listenPort });
    } catch (e: unknown) {
        await srtlaServices.stopSrtla();
        throw e;
    }
}

export async function stopCombined(): Promise<void> {
    await encoderServices.encoder().stop();
    await srtlaServices.stopSrtla();
}

// ----------------------------------------------------------------------
// Autostart
// ----------------------------------------------------------------------
let retryTimer: ReturnType<typeof setTimeout> | null = null;

export async function setAutostart(enabled: boolean): Promise<void> {
    state.autostart = enabled;
    if (!enabled) cancelAutostart();
    await saveState();
}

/** Stop a pending autostart retry; called whenever the user starts or stops something by hand. */
export function cancelAutostart(): void {
    if (retryTimer) clearTimeout(retryTimer);
    retryTimer = null;
}

/** Start the role's stream from saved settings. Returns false when there is nothing to start. */
async function startSaved(): Promise<boolean> {
    const cfg = state.encoder.config;
    switch (ROLE) {
        case "relay": {
            const t = state.srtlaTarget;
            if (!t) return false;
            if (!srtlaServices.srtlaStatus().running) await srtlaServices.startSrtla(t.listenPort, t.remoteHost, t.remotePort);
            return true;
        }
        case "encoder":
            if (!cfg) return false;
            if (!encoderServices.encoder().status().running) await encoderServices.encoder().start(cfg);
            return true;
        case "combined":
            if (!cfg || !state.stream) return false;
            if (!encoderServices.encoder().status().running) await startCombined(state.stream, cfg);
            return true;
        default:
            // obs/custom roles have no stream of their own
            return false;
    }
}

export function runAutostart(): void {
    if (!state.autostart) return;
    cancelAutostart();
    const attempt = async () => {
        retryTimer = null;
        try {
            if (await startSaved()) {
                console.log("Autostart complete");
                logEvent("info", "Autostart", t("log.stream_resumed"));
            } else {
                console.log("Autostart enabled, but no previous stream settings to resume");
                logEvent("warn", "Autostart", t("log.no_stream_settings"));
            }
        } catch (err: unknown) {
            // Capture cards, receivers or uplinks may simply not be ready yet after boot
            const msg = errorMessage(err);
            console.warn(`Autostart failed, retrying in ${AUTOSTART_RETRY_MS / 1000}s:`, msg);
            logEvent("warn", "Autostart", t("log.stream_start_retry", AUTOSTART_RETRY_MS / 1000, msg));
            if (state.autostart) retryTimer = setTimeout(() => void attempt(), AUTOSTART_RETRY_MS);
        }
    };
    void attempt();
}
