/*
 * Shared process supervision: keeps a child alive while wanted, restarts it
 * after a delay on unexpected exits, and stops it cleanly on demand.
 *
 * The starter does everything needed to (re)create the process (adapted
 * pipeline file, spawn, pid bookkeeping) and returns it. `onExit` sees one
 * exit per started process (not a requested stop); if the process is still
 * wanted it may update persistent state and call `scheduleRestart()`.
 */
import { logEvent } from "./eventlog";
import { t } from "./i18n";
import { errorMessage } from "./util";

type Starter = () => Promise<Bun.Subprocess> | Bun.Subprocess;

export class Supervisor {
    private proc: Bun.Subprocess | null = null;
    private timer: ReturnType<typeof setTimeout> | null = null;
    private wantedFlag = false;
    private starter: Starter | null = null;

    constructor(
        private readonly name: string,
        private readonly restartDelayMs: number,
        private readonly onExit: (code: number | null) => void,
    ) {}

    get running(): boolean {
        return this.proc !== null && this.proc.exitCode === null;
    }

    get pid(): number | undefined {
        return this.proc?.pid;
    }

    get wanted(): boolean {
        return this.wantedFlag;
    }

    /** Mark the target as wanted without spawning (used by --dry-run). */
    markWanted(): void {
        this.wantedFlag = true;
    }

    /** Spawn via starter and watch the child; failures propagate to the caller. */
    async start(starter: Starter): Promise<void> {
        this.wantedFlag = true;
        this.starter = starter;
        this.watch(await Promise.resolve(starter()));
    }

    /** Stop (SIGTERM, optionally escalated to SIGKILL) and wait until it is gone. */
    async stop(escalateAfterMs?: number): Promise<void> {
        const proc = this.proc;
        this.proc = null;
        this.wantedFlag = false;
        this.starter = null;
        this.clearTimer();
        if (proc && proc.exitCode === null) {
            proc.kill("SIGTERM");
            const killer = escalateAfterMs
                ? setTimeout(() => proc.kill("SIGKILL"), escalateAfterMs)
                : null;
            await proc.exited.catch(() => {});
            if (killer) clearTimeout(killer);
        }
    }

    /** Restart after the configured delay; no-op if stopped or running meanwhile. */
    scheduleRestart(): void {
        if (!this.wantedFlag || this.proc || this.timer || !this.starter) return;
        const starter = this.starter;
        console.warn(`${this.name} stopped unexpectedly; restarting in ${this.restartDelayMs / 1000}s`);
        this.timer = setTimeout(() => {
            this.timer = null;
            if (!this.wantedFlag || this.proc || !this.starter) return;
            Promise.resolve(starter()).then(
                (proc) => this.watch(proc),
                (err: unknown) => {
                    const msg = errorMessage(err);
                    console.error(`${this.name} restart failed:`, msg);
                    logEvent("error", this.name, t("log.restart_failed", msg));
                    this.scheduleRestart();
                },
            );
        }, this.restartDelayMs);
    }

    private watch(proc: Bun.Subprocess): void {
        this.proc = proc;
        proc.exited.then((code) => {
            if (this.proc !== proc) return;   // replaced; the new handler owns that exit
            this.proc = null;
            this.clearTimer();
            this.onExit(code ?? null);
        }).catch(() => {});
    }

    private clearTimer(): void {
        if (this.timer) { clearTimeout(this.timer); this.timer = null; }
    }
}
