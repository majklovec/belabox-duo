/*
 * Small runtime-agnostic helpers shared by the backend and the web UI.
 */

/** Message of an unknown thrown value (never needs to throw itself). */
export function errorMessage(err: unknown): string {
    return err instanceof Error ? err.message : String(err);
}

/** Text of a WebSocket / stream message that may arrive as a string already. */
export function textOf(data: unknown): string {
    return typeof data === "string" ? data : new TextDecoder().decode(data as ArrayBuffer | Uint8Array);
}

/** A parsed JSON object (not an array or scalar), or null when the text is anything else. */
export function parseJsonObject(text: string): Record<string, unknown> | null {
    try {
        const v: unknown = JSON.parse(text);
        return v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
    } catch {
        return null;
    }
}

/**
 * Deterministic JSON for the persisted files: 2-space indent, trailing newline,
 * and keys sorted alphabetically at each level (scalar properties first, objects
 * after) so the config file diffs cleanly.
 */
export function stableStringify(value: unknown): string {
    const isObj = (v: unknown) => v !== null && typeof v === "object";
    function fmt(v: unknown, indent: string): string {
        if (!isObj(v)) return JSON.stringify(v) ?? "null";
        const pad = indent + "  ";
        if (Array.isArray(v)) {
            return v.length ? `[\n${v.map((item) => pad + fmt(item, pad)).join(",\n")}\n${indent}]` : "[]";
        }
        const obj = v as Record<string, unknown>;
        const keys = Object.keys(obj)
            .filter((k) => obj[k] !== undefined)
            .sort((a, b) => Number(isObj(obj[a])) - Number(isObj(obj[b])) || a.localeCompare(b));
        if (!keys.length) return "{}";
        return `{\n${keys.map((k) => `${pad}${JSON.stringify(k)}: ${fmt(obj[k], pad)}`).join(",\n")}\n${indent}}`;
    }
    return fmt(value, "") + "\n";
}

/** URL with credentials and query removed, for logging; invalid input comes back unchanged. */
export function scrubUrl(url: string): string {
    try {
        const u = new URL(url);
        u.username = u.password = "";
        u.search = "";
        return u.toString();
    } catch {
        return url;
    }
}

/**
 * Reads a byte stream line by line (UTF-8, trimmed, blank lines skipped). The
 * generator finishes when the stream closes; returning early abandons it.
 */
export async function* readLines(stream: ReadableStream<Uint8Array>): AsyncGenerator<string> {
    const decoder = new TextDecoder();
    let buffer = "";
    for await (const chunk of stream) {
        buffer += decoder.decode(chunk, { stream: true });
        const lines = buffer.split("\n");
        buffer = lines.pop()!;
        for (const line of lines) if (line.trim()) yield line.trim();
    }
    if (buffer.trim()) yield buffer.trim();
}
