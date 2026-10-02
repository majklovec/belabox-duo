import { $ } from "bun";
import { DRY_RUN } from "./config";
import { errorMessage } from "./util";

/** Run a command and return its trimmed stdout; throws with stderr on failure. */
export async function query(cmd: string, args: string[]): Promise<string> {
    try {
        return (await $`${cmd} ${args}`.quiet().text()).trim();
    } catch (err: unknown) {
        const stderr = err && typeof err === "object" && "stderr" in err && err.stderr instanceof Uint8Array
            ? new TextDecoder().decode(err.stderr)
            : "";
        throw new Error(`${cmd} ${args.join(" ")} failed: ${stderr || errorMessage(err)}`);
    }
}

/** Like query(), but only printed under --dry-run (ModemManager / NetworkManager calls still run). */
export async function run(cmd: string, args: string[], ignoreError = false): Promise<string> {
    if (DRY_RUN && !cmd.includes("mmcli") && !cmd.includes("nmcli")) {
        console.log(`[DRY-RUN] ${cmd} ${args.join(" ")}`);
        return "";
    }
    try {
        return await query(cmd, args);
    } catch (err: unknown) {
        if (ignoreError) return "";
        throw err;
    }
}

export const ip = (args: string[], ignoreError = false) => run("ip", args, ignoreError);
