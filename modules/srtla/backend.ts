/*
 * srtla_send process management: start / stop / reload (SIGHUP or restart).
 */
import { DRY_RUN, RELOAD_MODE, SRTLA_SOCKET, UPLINKS_FILE } from "../../src/config";
import { logEvent } from "../../src/eventlog";
import { t } from "../../src/i18n";
import { type SrtlaOptions, type SrtlaOptionsResult, saveState, state } from "../../src/state";
import { Supervisor } from "../../src/supervisor";
import { errorMessage } from "../../src/util";
import {
	type SrtlaCapabilities,
	latestSrtlaStats,
	prepareSrtlaControl,
	SRTLA_MODES,
	rpc,
	srtlaCapabilities,
	srtlaControlState,
	startSrtlaControl,
	stopSrtlaControl,
} from "../../src/srtlaControl";

const RESTART_DELAY_MS = 2_000;

const supervisor = new Supervisor("SRTLA", RESTART_DELAY_MS, onSrtlaExit);
// Target of the last startSrtla(); state.srtlaTarget may already hold a newer, not yet started one
let startedTarget: [listenPort: string, remoteHost: string, remotePort: string] | null = null;
let dryRunActive = false;   // --dry-run has no process to track

const isRunning = (): boolean => DRY_RUN ? dryRunActive : supervisor.running;

function srtlaStatus(): SrtlaState {
	if (isRunning()) return state.srtla;
	// Keep the last target so the UI can prefill the form after a stop
	const live = state.srtla;
	const target = state.srtlaTarget ?? { listenPort: live.listenPort, remoteHost: live.remoteHost, remotePort: live.remotePort };
	return { running: false, ...target, reloadCount: live.reloadCount, lastReloadAt: live.lastReloadAt };
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
	const pid = isRunning() ? supervisor.pid : undefined;
	if (!pid) return false;
	try {
		process.kill(pid, "SIGHUP");
		console.log(`Sent SIGHUP to srtla_send (pid ${pid})`);
		return true;
	} catch (err: unknown) {
		console.warn(`Failed to signal srtla_send: ${errorMessage(err)}`);
		return false;
	}
}

/**
 * Reload srtla_send after an uplinks-file change.
 * Default strategy: SIGHUP.  Fallback / explicit: restart.
 */
async function reloadSrtla(): Promise<void> {
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

	const target = startedTarget;
	if (!target) {
		console.warn("No srtla_send args cached — cannot restart");
		return;
	}
	console.log("Restarting srtla_send to pick up new uplinks file...");
	await stopSrtla();
	await Bun.sleep(200);
	await startSrtla(...target);
}

async function startSrtla(
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
	startedTarget = [listenPort, remoteHost, remotePort];
	console.log(`Starting ${bin} listen: ${listenPort} target: ${remoteHost}:${remotePort} ${UPLINKS_FILE}`);

	const s: SrtlaState = { running: true, listenPort, remoteHost, remotePort, startedAt: Date.now() };
	if (caps) {
		await supervisor.start(() => spawnSrtla(bin, listenPort, remoteHost, remotePort, caps));
		Object.assign(s, { pid: supervisor.pid, reloadCount: state.srtla.reloadCount ?? 0 });
	} else {
		dryRunActive = true;
	}
	state.srtla = s;
	await saveState();
	return s;
}

function spawnSrtla(
	bin: string,
	listenPort: string,
	remoteHost: string,
	remotePort: string,
	caps: SrtlaCapabilities,
): Bun.Subprocess {
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
	if (control) startSrtlaControl(SRTLA_SOCKET);
	return proc;
}

/** srtla_send died on its own (e.g. all uplinks lost): keep retrying like belaUI does. */
function onSrtlaExit(code: number | null): void {
	console.log(`srtla_send exited with code ${code}`);
	stopSrtlaControl();
	state.srtla = { running: false, reloadCount: state.srtla.reloadCount };
	saveState().catch(() => {});
	if (!supervisor.wanted) return;
	logEvent("warn", "SRTLA", t("log.srtla_exited", code, RESTART_DELAY_MS / 1000));
	supervisor.scheduleRestart();
}

async function stopSrtla(): Promise<void> {
	await supervisor.stop();
	stopSrtlaControl();
	dryRunActive = false;
	state.srtla = { ...state.srtla, running: false };
	await saveState();
}

/**
 * Persist scheduler settings and apply them to a running srtla_send over its control
 * socket. `applied` is false when they only take effect on the next start.
 */
async function setSrtlaOptions(opts: SrtlaOptions): Promise<SrtlaOptionsResult> {
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
async function maybeStartSrtla(argv: string[]): Promise<boolean> {
	const startIdx = argv.indexOf("--start-srtla");
	if (startIdx === -1) return false;
	if (startIdx + 3 >= argv.length) {
		console.warn("--start-srtla requires <listenPort> <remoteHost> <remotePort>");
		return false;
	}
	await startSrtla(argv[startIdx + 1], argv[startIdx + 2], argv[startIdx + 3]);
	return true;
}
import type { DeviceModule, ModuleContext, SrtlaState } from "../types";

/**
 * SRTLA services consumed by the core (stream orchestration, shutdown,
 * autostart) — the registry is the door into the srtla module.
 */
export const srtlaServices = {
	srtlaStatus,
	startSrtla,
	stopSrtla,
	reloadSrtla,
	setSrtlaOptions,
	maybeStartSrtla,
	/** srtla_send control-socket state for the status build. */
	controlState: srtlaControlState,
	/** Latest srtla_send stats snapshot (the `srtla.stats` method). */
	latestStats: latestSrtlaStats,
	/** Valid scheduler modes (for the core's parameter validation). */
	modes: SRTLA_MODES,
};

const methods = ["srtla.status", "srtla.start", "srtla.stop", "srtla.reload", "srtla.stats", "srtla.options"] as const;

export const srtlaModule: DeviceModule = {
	id: "srtla",
	title: "SRTLA",
	configSchema: null,
	secretFields: [],
	async start(_ctx: ModuleContext) {},
	async stop() {
		await stopSrtla();
	},
	methods,
	events: [],
	async dispatch(method, params) {
		switch (method) {
			case "srtla.status":
				return srtlaStatus();
			case "srtla.start":
				return startSrtla(String(params["listenPort"]), String(params["remoteHost"]), String(params["remotePort"]));
			case "srtla.stop":
				await stopSrtla();
				return srtlaStatus();
			case "srtla.reload":
				await reloadSrtla();
				return srtlaStatus();
			case "srtla.stats":
				return latestSrtlaStats();
			case "srtla.options":
				return setSrtlaOptions(params as unknown as SrtlaOptions);
			default:
				throw new Error(`unknown method ${method}`);
		}
	},
};
