import { tmpdir } from "node:os";
import { join } from "node:path";

export const argv = Bun.argv.slice(2);
const flag = (name: string): boolean => argv.includes(name);

const argFail = (name: string, value: string, expected: string): never => {
    console.error(`Invalid value for ${name}: "${value}" (expected ${expected})`);
    process.exit(2);
};

/** Reads `--name value` or `--name=value`; the overload guarantees a string when a fallback is given. */
function arg(name: string): string | undefined;
function arg(name: string, fallback: string): string;
function arg(name: string, fallback?: string): string | undefined {
    const prefix = `${name}=`;
    for (let i = 0; i < argv.length; i++) {
        const a = argv[i];
        if (a === name) return argv[i + 1] ?? fallback;
        if (a.startsWith(prefix)) return a.slice(prefix.length);
    }
    return fallback;
}

const intArg = (name: string, fallback: number, min = 0, max = Number.MAX_SAFE_INTEGER): number => {
    const raw = arg(name);
    if (raw === undefined) return fallback;
    const n = Number(raw);
    return Number.isInteger(n) && n >= min && n <= max ? n : argFail(name, raw, `integer ${min}-${max}`);
};

const enumArg = <T extends string>(name: string, allowed: readonly T[], fallback: T): T => {
    const raw = arg(name);
    if (raw === undefined) return fallback;
    return (allowed as readonly string[]).includes(raw) ? (raw as T) : argFail(name, raw, allowed.join(" | "));
};

const TMP = tmpdir();
export const CONFIG_FILE     = arg("--config", "modems.json");
export const STATE_FILE      = arg("--state", join(TMP, "srtla_state.json"));
export const UPLINKS_FILE    = arg("--uplinks", join(TMP, "srtla_ips.txt"));
export const DRY_RUN         = flag("--dry-run");
export const API_MODE        = flag("--api");
export const API_PORT        = intArg("--port", 8085, 1, 65535);
export const API_HOST        = arg("--host", "127.0.0.1");
export const MONITOR         = flag("--monitor") || API_MODE;   // API mode implies monitor
export const RELOAD_MODE     = enumArg("--srtla-reload", ["signal", "restart"] as const, "signal");
export const DEBOUNCE_MS     = intArg("--debounce-ms", 1500);
