/*
 * srtla_send process management: start / stop / reload (SIGHUP or restart).
 */
import { DRY_RUN, RELOAD_MODE, SRTLA_SOCKET, UPLINKS_FILE } from "./config";
import { logEvent } from "./eventlog";
import { type SrtlaOptions, saveState, state } from "./state";
import {
    prepareSrtlaControl,
    rpc,
    srtlaCapabilities,
    srtlaControlState,
    startSrtlaControl,
    stopSrtlaControl,
} from "./srtlaControl";

export interface SrtlaState {
    running: boolean;
    pid?: number;
    listenPort?: string;
    remoteHost?: string;
    remotePort?: string;
    startedAt?: number;
    lastReloadAt?: number;
    reloadCount?: number;
}

let srtlaProc: Bun.Subprocess | null = null;
let srtlaArgs: [string, string, string] | null = null;

let dryRunActive = false;   // --dry-run has no process to track
let wanted = false;         // srtla_send should be running; unexpected exits are restarted
let restartTimer: ReturnType<typeof setTimeout> | null = null;
const RESTART_DELAY_MS = 2_000;

const isRunning = (): boolean => DRY_RUN ? dryRunActive : srtlaProc !== null && srtlaProc.exitCode === null;

export function srtlaStatus(): SrtlaState {
    if (isRunning()) return state.srtla;
    if (state.srtla.running && srtlaProc === null && !DRY_RUN) return { ...state.srtla, running: false };
    return { running: false };
}

/**
 * Send SIGHUP to srtla_send (asking it to re-read the uplinks file).
 * Returns true if the signal was delivered, false otherwise.
 */
function signalSrtlaReload(): boolean {
    if (DRY_RUN) {
        console.log("[DRY-RUN] SIGHUP srtla_send");
        return true;
    }
    const pid = isRunning() ? srtlaProc?.pid : undefined;
    if (!pid) return false;
    try {
        process.kill(pid, "SIGHUP");
        console.log(`Sent SIGHUP to srtla_send (pid ${pid})`);
        return true;
    } catch (err: unknown) {
        console.warn(`Failed to signal srtla_send: ${err instanceof Error ? err.message : String(err)}`);
        return false;
    }
}

/**
 * Reload srtla_send after an uplinks-file change.
 * Default strategy: SIGHUP.  Fallback / explicit: restart.
 */
export async function reloadSrtla(): Promise<void> {
    if (!isRunning()) return;

    if (RELOAD_MODE === "signal") {
        if (signalSrtlaReload()) {
            state.srtla.lastReloadAt = Date.now();
            state.srtla.reloadCount  = (state.srtla.reloadCount ?? 0) + 1;
            await saveState();
            return;
        }
        console.warn("SIGHUP failed — falling back to restart");
    }

    if (!srtlaArgs) {
        console.warn("No srtla_send args cached — cannot restart");
        return;
    }
    const args = srtlaArgs;
    console.log("Restarting srtla_send to pick up new uplinks file...");
    await stopSrtla();
    await Bun.sleep(200);
    await startSrtla(...args);
}

export async function startSrtla(
    listenPort: string, remoteHost: string, remotePort: string
): Promise<SrtlaState> {
    const bin = process.env.SRTLA_SEND_BIN ?? "srtla_send";
    // Only pass flags this srtla_send build understands (the BELABOX C version has none of them).
    // Probed before the running check so check → spawn stays free of awaits.
    const caps = DRY_RUN ? null : await srtlaCapabilities(bin);
    if (isRunning()) {
        throw new Error("srtla_send is already running");
    }

    // Save the requested receiver before spawning so failed starts still
    // leave the UI with a complete target to restore.
    state.srtlaTarget = { listenPort, remoteHost, remotePort };
    await saveState();
    srtlaArgs = [listenPort, remoteHost, remotePort];
    console.log(`Starting ${bin} listen: ${listenPort} target: ${remoteHost}:${remotePort} ${UPLINKS_FILE}`);

    if (!caps) {
        const s: SrtlaState = { running: true, listenPort, remoteHost, remotePort, startedAt: Date.now() };
        dryRunActive = true;
        state.srtla = s;
        await saveState();
        return s;
    }

    const opts = state.srtlaOptions ?? {};
    const control = !!SRTLA_SOCKET && caps.controlSocket;
    const flags: string[] = [];
    if (control) flags.push("--control-socket", SRTLA_SOCKET);
    if (caps.mode && opts.mode) flags.push("--mode", opts.mode);
    if (caps.quality && opts.quality === false) flags.push("--no-quality");
    prepareSrtlaControl(SRTLA_SOCKET, control);

    const proc = Bun.spawn(
        [bin, ...flags, listenPort, remoteHost, remotePort, UPLINKS_FILE],
        { stdout: "inherit", stderr: "inherit", stdin: "inherit" }
    );
    srtlaProc = proc;
    wanted = true;
    if (control) startSrtlaControl(SRTLA_SOCKET);

    const s: SrtlaState = {
        running: true,
        pid: proc.pid,
        listenPort, remoteHost, remotePort,
        startedAt: Date.now(),
        reloadCount: state.srtla.reloadCount ?? 0,
    };
    state.srtla = s;
    await saveState();

    proc.exited.then((code) => {
        console.log(`srtla_send exited with code ${code}`);
        if (srtlaProc !== proc) return;   // already replaced by a restart
        stopSrtlaControl();
        state.srtla = { running: false, reloadCount: state.srtla.reloadCount };
        srtlaProc = null;
        saveState().catch(() => {});
        if (!wanted) return;
        logEvent("warn", "SRTLA", `srtla_send exited with code ${code}; restarting in ${RESTART_DELAY_MS / 1000}s`);
        scheduleRestart();
    });

    return s;
}

/** srtla_send died on its own (e.g. all uplinks lost): keep retrying like belaUI does. */
function scheduleRestart(): void {
    const args = srtlaArgs;
    if (!args || restartTimer) return;
    console.warn(`srtla_send stopped unexpectedly; restarting in ${RESTART_DELAY_MS / 1000}s`);
    restartTimer = setTimeout(async () => {
        restartTimer = null;
        if (!wanted || isRunning()) return;
        try {
            await startSrtla(...args);
        } catch (err: unknown) {
            const msg = err instanceof Error ? err.message : String(err);
            console.error("srtla_send restart failed:", msg);
            logEvent("error", "SRTLA", `Restart failed: ${msg}`);
            scheduleRestart();
        }
    }, RESTART_DELAY_MS);
}

export async function stopSrtla(): Promise<void> {
    wanted = false;   // before killing, so the exit handler does not restart it
    if (restartTimer) clearTimeout(restartTimer);
    restartTimer = null;
    if (srtlaProc && isRunning()) {
        srtlaProc.kill("SIGTERM");
        await srtlaProc.exited;
    }
    stopSrtlaControl();
    srtlaProc = null;
    dryRunActive = false;
    state.srtla = { ...state.srtla, running: false };
    await saveState();
}

/**
 * Persist scheduler settings and apply them to a running srtla_send over its control
 * socket. `applied` is false when they only take effect on the next start.
 */
export async function setSrtlaOptions(opts: SrtlaOptions): Promise<{ options: SrtlaOptions; applied: boolean }> {
    state.srtlaOptions = { ...state.srtlaOptions, ...opts };
    await saveState();
    if (DRY_RUN) {
        console.log(`[DRY-RUN] srtla_send options ${JSON.stringify(opts)}`);
        return { options: state.srtlaOptions, applied: isRunning() };
    }
    if (!isRunning() || !srtlaControlState().connected) return { options: state.srtlaOptions, applied: false };
    if (opts.mode) await rpc("set_mode", { mode: opts.mode });
    if (opts.quality !== undefined) await rpc("set_quality", { enabled: opts.quality });
    return { options: state.srtlaOptions, applied: true };
}

/** Honor `--start-srtla <listenPort> <remoteHost> <remotePort>` if present. */
export async function maybeStartSrtla(argv: string[]): Promise<boolean> {
    const startIdx = argv.indexOf("--start-srtla");
    if (startIdx === -1) return false;
    if (startIdx + 3 >= argv.length) {
        console.warn("--start-srtla requires <listenPort> <remoteHost> <remotePort>");
        return false;
    }
    await startSrtla(argv[startIdx + 1], argv[startIdx + 2], argv[startIdx + 3]);
    return true;
}