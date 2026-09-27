/*
 * srtla_send process management: start / stop / reload (SIGHUP or restart).
 */
import { DRY_RUN, RELOAD_MODE, UPLINKS_FILE } from "./config";
import { saveState, state } from "./state";

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
    if (isRunning()) {
        throw new Error("srtla_send is already running");
    }

    srtlaArgs = [listenPort, remoteHost, remotePort];
    state.srtlaTarget = { listenPort, remoteHost, remotePort };
    const bin = process.env.SRTLA_SEND_BIN ?? "srtla_send";
    console.log(`Starting ${bin} listen: ${listenPort} target: ${remoteHost}:${remotePort} ${UPLINKS_FILE}`);

    if (DRY_RUN) {
        const s: SrtlaState = { running: true, listenPort, remoteHost, remotePort, startedAt: Date.now() };
        dryRunActive = true;
        state.srtla = s;
        await saveState();
        return s;
    }

    const proc = Bun.spawn(
        [bin, listenPort, remoteHost, remotePort, UPLINKS_FILE],
        { stdout: "inherit", stderr: "inherit", stdin: "inherit" }
    );
    srtlaProc = proc;
    wanted = true;

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
        state.srtla = { running: false, reloadCount: state.srtla.reloadCount };
        srtlaProc = null;
        saveState().catch(() => {});
        if (wanted) scheduleRestart();
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
            console.error("srtla_send restart failed:", err instanceof Error ? err.message : String(err));
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
    srtlaProc = null;
    dryRunActive = false;
    state.srtla = { ...state.srtla, running: false };
    await saveState();
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