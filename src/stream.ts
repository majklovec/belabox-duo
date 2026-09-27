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
import { type EncoderConfig, encoderStatus, startEncoder, stopEncoder, validateEncoderConfig } from "./encoder";
import { srtlaStatus, startSrtla, stopSrtla } from "./srtla";
import { saveState, type StreamTarget, state } from "./state";

const AUTOSTART_RETRY_MS = 5_000;

/** Bring up srtla_send (reusing it if already aimed at the same target), then belacoder into it. */
export async function startCombined(target: StreamTarget, cfg: EncoderConfig): Promise<void> {
    if (encoderStatus().running) throw new Error("already streaming");
    await validateEncoderConfig(cfg);   // fail before touching srtla_send

    const { listenPort, remoteHost, remotePort } = target;
    const s = srtlaStatus();
    if (s.running && (s.listenPort !== listenPort || s.remoteHost !== remoteHost || s.remotePort !== remotePort)) {
        await stopSrtla();
    }
    if (!srtlaStatus().running) await startSrtla(listenPort, remoteHost, remotePort);

    state.stream = target;
    await saveState();
    try {
        await startEncoder({ ...cfg, host: "127.0.0.1", port: listenPort });
    } catch (e: unknown) {
        await stopSrtla();
        throw e;
    }
}

export async function stopCombined(): Promise<void> {
    await stopEncoder();
    await stopSrtla();
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
            if (!srtlaStatus().running) await startSrtla(t.listenPort, t.remoteHost, t.remotePort);
            return true;
        }
        case "encoder":
            if (!cfg) return false;
            if (!encoderStatus().running) await startEncoder(cfg);
            return true;
        case "combined":
            if (!cfg || !state.stream) return false;
            if (!encoderStatus().running) await startCombined(state.stream, cfg);
            return true;
    }
}

export function runAutostart(): void {
    if (!state.autostart) return;
    cancelAutostart();
    const attempt = async () => {
        retryTimer = null;
        try {
            if (await startSaved()) console.log("Autostart complete");
            else console.log("Autostart enabled, but no previous stream settings to resume");
        } catch (err: unknown) {
            // Capture cards, receivers or uplinks may simply not be ready yet after boot
            console.warn(`Autostart failed, retrying in ${AUTOSTART_RETRY_MS / 1000}s:`,
                err instanceof Error ? err.message : String(err));
            if (state.autostart) retryTimer = setTimeout(() => void attempt(), AUTOSTART_RETRY_MS);
        }
    };
    void attempt();
}
