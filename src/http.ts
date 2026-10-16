/*
 * HTTP helpers shared by the device API (src/api.ts) and the control server (server.ts).
 */

export const text = (body: string, status = 200, headers?: HeadersInit): Response =>
    new Response(`${body}\n`, { status, headers });

export const notFound = (): Response => text("Not found", 404);

export const upgradeRequired = (): Response =>
    text("Expected a WebSocket upgrade", 426, { upgrade: "websocket" });

/**
 * Browsers always send `Origin`; reject cross-site pages so a random website cannot
 * drive the WebSocket API. Non-browser clients (no Origin) are allowed.
 */
export function originAllowed(req: Request, extra: readonly string[] = []): boolean {
    const origin = req.headers.get("origin");
    if (!origin || extra.includes("*") || extra.includes(origin)) return true;
    try {
        return new URL(origin).host === req.headers.get("host");
    } catch {
        return false;
    }
}

const I18N_PATH_RE = /^\/i18n\/([a-z]{2})\.json$/;

/**
 * `/i18n/<lang>.json` — the on-demand i18next bundle the browser fetches when
 * a language is selected. The path is not content-hashed, so it is served
 * `no-cache` (tiny file, revalidated on every fetch). `catalog` maps a valid
 * language code to its records (loaded on demand and cached), or null for
 * unknown codes.
 */
export async function i18nResponse(
	path: string,
	catalog: (lang: string) => Promise<Record<string, string> | null>,
): Promise<Response> {
	const m = I18N_PATH_RE.exec(path);
	const c = m ? await catalog(m[1]) : null;
	return c
		? new Response(JSON.stringify(c), {
				headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-cache" },
			})
		: notFound();
}

const IMG_PATH_RE = /^\/img\/[\w-]+\.svg$/;

/** Role diagrams of the setup wizard (`/img/<name>.svg` from public/); null for other paths. */
export async function imageResponse(path: string): Promise<Response | null> {
    if (!IMG_PATH_RE.test(path)) return null;
    const file = Bun.file(new URL(`../public${path}`, import.meta.url));
    return (await file.exists())
        ? new Response(file, { headers: { "content-type": "image/svg+xml; charset=utf-8", "cache-control": "no-cache" } })
        : notFound();
}
