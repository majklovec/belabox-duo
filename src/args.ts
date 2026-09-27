/* Minimal CLI argument helpers shared by the relay and the control server. */
export const argv = Bun.argv.slice(2);
export const flag = (name: string): boolean => argv.includes(name);

export const argFail = (name: string, value: string, expected: string): never => {
    console.error(`Invalid value for ${name}: "${value}" (expected ${expected})`);
    process.exit(2);
};

/** Reads `--name value` or `--name=value`; the overload guarantees a string when a fallback is given. */
export function arg(name: string): string | undefined;
export function arg(name: string, fallback: string): string;
export function arg(name: string, fallback?: string): string | undefined {
    const prefix = `${name}=`;
    for (let i = 0; i < argv.length; i++) {
        const a = argv[i];
        if (a === name) return argv[i + 1] ?? fallback;
        if (a.startsWith(prefix)) return a.slice(prefix.length);
    }
    return fallback;
}

export const intArg = (name: string, fallback: number, min = 0, max = Number.MAX_SAFE_INTEGER): number => {
    const raw = arg(name);
    if (raw === undefined) return fallback;
    const n = Number(raw);
    return Number.isInteger(n) && n >= min && n <= max ? n : argFail(name, raw, `integer ${min}-${max}`);
};

export const enumArg = <T extends string>(name: string, allowed: readonly T[], fallback: T): T => {
    const raw = arg(name);
    if (raw === undefined) return fallback;
    return (allowed as readonly string[]).includes(raw) ? (raw as T) : argFail(name, raw, allowed.join(" | "));
};
