import { $ } from "bun";
import { DRY_RUN } from "./config";
import { errorMessage } from "./util";

export async function run(cmd: string, args: string[], ignoreError = false): Promise<string> {
    if (DRY_RUN && !cmd.includes("mmcli") && !cmd.includes("nmcli")) {
        console.log(`[DRY-RUN] ${cmd} ${args.join(" ")}`);
        return "";
    }
    try {
        const out = await $`${cmd} ${args}`.quiet().text();
        return out.trim();
    } catch (err: unknown) {
        if (ignoreError) return "";
        const message = errorMessage(err);
        const stderr = err && typeof err === "object" && "stderr" in err && err.stderr instanceof Uint8Array
            ? new TextDecoder().decode(err.stderr)
            : "";
        throw new Error(`${cmd} ${args.join(" ")} failed: ${stderr || message}`);
    }
}

export const ip = (args: string[], ignoreError = false) => run("ip", args, ignoreError);
