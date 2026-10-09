/*
 * srtla module: srtla_send process management — start / stop / reload (SIGHUP
 * or restart) and the scheduler options applied over the control socket.
 *
 * Self-contained: the only core edge is the `core` bag handed in at start.
 */
import { z } from "zod";
import {
	SRTLA_MODES,
	type SrtlaCapabilities,
	type Mctx,
	type SrtlaCore,
	type SrtlaOptions,
	type SrtlaOptionsResult,
	type SrtlaState,
} from "./types";

const RESTART_DELAY_MS = 2_000;

/** Core bag, filled at start (a module may not import the core directly). */
let core: SrtlaCore;

const sc = () => core.srtlaControl;

// The module is imported before start binds `core`, so the supervisor is built
// lazily on first use (the original created it at import; behaviour is
// identical because start is the first entry point that touches it).
type Sup = InstanceType<SrtlaCore["Supervisor"]>;
let sup: Sup | undefined;

function supervisorRef(): Sup {
	if (!sup) sup = new core.Supervisor("SRTLA", RESTART_DELAY_MS, onSrtlaExit);
	return sup;
}

// Target of the last startSrtla(); state.srtlaTarget may already hold a newer, not yet started one
let startedTarget: [listenPort: string, remoteHost: string, remotePort: string] | null = null;
let dryRunActive = false;   // --dry-run has no process to track

const isRunning = (): boolean => core.config.DRY_RUN ? dryRunActive : supervisorRef().running;

function srtlaStatus(): SrtlaState {
	if (isRunning()) return core.state.srtla;
	// Keep the last target so the UI can prefill the form after a stop
	const live = core.state.srtla;
	const target = core.state.srtlaTarget ?? { listenPort: live.listenPort ?? "", remoteHost: live.remoteHost ?? "", remotePort: live.remotePort ?? "" };
	return { running: false, ...target, reloadCount: live.reloadCount, lastReloadAt: live.lastReloadAt };
}

/**
 * Send SIGHUP to srtla_send (asking it to re-read the uplinks file).
 * Returns true if the signal was delivered, false otherwise.
 */
function signalSrtlaReload(): boolean {
	if (core.config.DRY_RUN) {
		console.log("[DRY-RUN] SIGHUP srtla_send");
		return true;
	}
	const pid = isRunning() ? supervisorRef().pid : undefined;
	if (!pid) return false;
	try {
		process.kill(pid, "SIGHUP");
		console.log(`Sent SIGHUP to srtla_send (pid ${pid})`);
		return true;
	} catch (err: unknown) {
		console.warn(`Failed to signal srtla_send: ${core.errorMessage(err)}`);
		return false;
	}
}

/**
 * Reload srtla_send after an uplinks-file change.
 * Default strategy: SIGHUP.  Fallback / explicit: restart.
 */
async function reloadSrtla(): Promise<void> {
	if (!isRunning()) return;

	if (core.config.RELOAD_MODE === "signal") {
		if (signalSrtlaReload()) {
			core.state.srtla.lastReloadAt = Date.now();
			core.state.srtla.reloadCount = (core.state.srtla.reloadCount ?? 0) + 1;
			await core.saveState();
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
	const caps = core.config.DRY_RUN ? null : await sc().srtlaCapabilities(bin);
	if (isRunning()) {
		throw new Error("srtla_send is already running");
	}

	// Save the requested receiver before spawning so failed starts still
	// leave the UI with a complete target to restore.
	core.state.srtlaTarget = { listenPort, remoteHost, remotePort };
	await core.saveState();
	startedTarget = [listenPort, remoteHost, remotePort];
	console.log(`Starting ${bin} listen: ${listenPort} target: ${remoteHost}:${remotePort} ${core.config.UPLINKS_FILE}`);

	const s: SrtlaState = { running: true, listenPort, remoteHost, remotePort, startedAt: Date.now() };
	if (caps) {
		await supervisorRef().start(() => spawnSrtla(bin, listenPort, remoteHost, remotePort, caps));
		Object.assign(s, { pid: supervisorRef().pid, reloadCount: core.state.srtla.reloadCount ?? 0 });
	} else {
		dryRunActive = true;
	}
	core.state.srtla = s;
	await core.saveState();
	return s;
}

function spawnSrtla(
	bin: string,
	listenPort: string,
	remoteHost: string,
	remotePort: string,
	caps: SrtlaCapabilities,
): Bun.Subprocess {
	const opts = core.state.srtlaOptions ?? {};
	const control = !!core.config.SRTLA_SOCKET && caps.controlSocket;
	const flags: string[] = [];
	if (control) flags.push("--control-socket", core.config.SRTLA_SOCKET);
	if (caps.mode && opts.mode) flags.push("--mode", opts.mode);
	if (caps.quality && opts.quality === false) flags.push("--no-quality");
	sc().prepareSrtlaControl(core.config.SRTLA_SOCKET, control);

	const proc = Bun.spawn(
		[bin, ...flags, listenPort, remoteHost, remotePort, core.config.UPLINKS_FILE],
		{ stdout: "inherit", stderr: "inherit", stdin: "inherit" }
	);
	if (control) sc().startSrtlaControl(core.config.SRTLA_SOCKET);
	return proc;
}

/** srtla_send died on its own (e.g. all uplinks lost): keep retrying like belaUI does. */
function onSrtlaExit(code: number | null): void {
	console.log(`srtla_send exited with code ${code}`);
	sc().stopSrtlaControl();
	core.state.srtla = { running: false, reloadCount: core.state.srtla.reloadCount };
	core.saveState().catch(() => {});
	if (!supervisorRef().wanted) return;
	core.logEvent("warn", "SRTLA", core.t("log.srtla_exited", code, RESTART_DELAY_MS / 1000));
	supervisorRef().scheduleRestart();
}

async function stopSrtla(): Promise<void> {
	if (!sup) return; // srtla_send was never started in this role — nothing to stop
	await supervisorRef().stop();
	sc().stopSrtlaControl();
	dryRunActive = false;
	core.state.srtla = { ...core.state.srtla, running: false };
	await core.saveState();
}

/**
 * Persist scheduler settings and apply them to a running srtla_send over its control
 * socket. `applied` is false when they only take effect on the next start.
 */
async function setSrtlaOptions(opts: SrtlaOptions): Promise<SrtlaOptionsResult> {
	core.state.srtlaOptions = { ...core.state.srtlaOptions, ...opts };
	await core.saveState();
	if (core.config.DRY_RUN) {
		console.log(`[DRY-RUN] srtla_send options ${JSON.stringify(opts)}`);
		return { options: core.state.srtlaOptions, applied: isRunning() };
	}
	if (!isRunning() || !sc().srtlaControlState().connected) return { options: core.state.srtlaOptions, applied: false };
	if (opts.mode) await sc().rpc("set_mode", { mode: opts.mode });
	if (opts.quality !== undefined) await sc().rpc("set_quality", { enabled: opts.quality });
	return { options: core.state.srtlaOptions, applied: true };
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

const methods = ["srtla.status", "srtla.start", "srtla.stop", "srtla.reload", "srtla.stats", "srtla.options"] as const;

/**
 * SRTLA services consumed by the core (stream orchestration, shutdown,
 * autostart) — exposed through the capability bus under "stream.srtla".
 */
const srtlaServices = {
	srtlaStatus,
	startSrtla,
	stopSrtla,
	reloadSrtla,
	setSrtlaOptions,
	maybeStartSrtla,
	/** srtla_send control-socket state for the status build. */
	controlState: () => sc().srtlaControlState(),
	/** Latest srtla_send stats snapshot (the `srtla.stats` method). */
	latestStats: () => sc().latestSrtlaStats(),
	/** Valid scheduler modes (for the core's parameter validation). */
	modes: SRTLA_MODES,
};

export default {
	kind: "device",
	id: "srtla",
	title: "SRTLA",
	configSchema: z.object({}).passthrough(),
	secretFields: [] as string[],
	async start(ctx: Mctx) {
		core = ctx.core;
	},
	async stop() {
		await stopSrtla();
	},
	methods,
	events: [] as string[],
	async dispatch(method: string, params: Record<string, unknown>) {
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
				return sc().latestSrtlaStats();
			case "srtla.options":
				return setSrtlaOptions(params as unknown as SrtlaOptions);
			default:
				throw new Error(`unknown method ${method}`);
		}
	},
	services: {
		capabilities: {
			"stream.srtla": srtlaServices,
		},
	},
};
