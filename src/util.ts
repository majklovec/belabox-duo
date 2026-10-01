/*
 * Small shared helpers used across the app.
 */

/** Message of an unknown thrown value (never needs to throw itself). */
export function errorMessage(err: unknown): string {
    return err instanceof Error ? err.message : String(err);
}

/** Text of a WebSocket / stream message that may arrive as a string already. */
export function textOf(data: unknown): string {
    return typeof data === "string" ? data : new TextDecoder().decode(new Uint8Array(data as ArrayBuffer));
}

/**
 * Deterministic JSON for the persisted files: 2-space indent, trailing newline,
 * and keys sorted alphabetically at each level (scalar properties first, objects
 * after) so the config file diffs cleanly.
 */
export function stableStringify(value: unknown): string {
    function fmt(v: unknown, indent: string): string {
        const pad = indent + "  ";
        if (v === null || typeof v !== "object") return JSON.stringify(v) ?? "null";
        if (Array.isArray(v)) {
            return v.length
                ? `[\n${v.map((item) => `${pad}${fmt(item, pad)}`).join(",\n")}\n${indent}]`
                : "[]";
        }
        const obj = v as Record<string, unknown>;
        const keys = Object.keys(obj)
            .filter((k) => obj[k] !== undefined)
            .sort((a, b) => {
                const aObj = obj[a] !== null && typeof obj[a] === "object";
                const bObj = obj[b] !== null && typeof obj[b] === "object";
                if (aObj !== bObj) return aObj ? 1 : -1;
                return a.localeCompare(b);
            });
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

/** Role-diagram helper for the setup wizard (`/img/<name>.svg` from public/). */
export async function svgResponse(path: string): Promise<Response> {
    const file = Bun.file(new URL(`../public${path}`, import.meta.url));
    return (await file.exists())
        ? new Response(file, { headers: { "content-type": "image/svg+xml; charset=utf-8", "cache-control": "no-cache" } })
        : new Response("Not found\n", { status: 404 });
}

/**
 * Reads a byte stream line by line (NUL-free, UTF-8). The generator finishes
 * when the stream closes; returning early abandons it.
 */
export async function* readLines(stream: ReadableStream<Uint8Array>): AsyncGenerator<string> {
    const decoder = new TextDecoder();
    let buffer = "";
    for await (const chunk of stream) {
        buffer += decoder.decode(chunk, { stream: true });
        let nl: number;
        while ((nl = buffer.indexOf("\n")) !== -1) {
            const line = buffer.slice(0, nl).trim();
            buffer = buffer.slice(nl + 1);
            if (line) yield line;
        }
    }
    if (buffer.trim()) yield buffer.trim();
}
