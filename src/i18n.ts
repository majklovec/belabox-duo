// i18n core for the Bun runtimes (control server, compiled device binary),
// built on i18next.
//
// Translations live as JSON catalogs in i18n/ (the source of truth, English
// in i18n/en.json). Only the default language is loaded eagerly; every other
// language is read on demand the first time it is requested and cached, so no
// catalog is loaded up front.
//
// A catalog is resolved from two candidate locations:
//   * `../i18n/<lang>.json` relative to this file — the real directory, for
//     the unbundled control server (bun server.ts) and dev;
//   * `./i18n/<lang>.json` relative to this file — the embedded copy, for
//     compiled binaries. `bun build --compile --asset i18n` embeds the whole
//     directory at the binary root, so this path finds it with no filesystem
//     access (a compiled binary is a flat file and cannot reach disk).
// The first candidate that resolves wins, which is why one resolver serves
// both contexts. The browser likewise loads languages on demand from
// /i18n/<lang>.json (see public/ts/i18n.tsx).
//
// t()/translate() keep their historical signatures: `{0}`, `{1}`, ... in the
// catalogs are replaced by the positional arguments (i18next interpolation
// configured accordingly). Missing keys fall back to English, then to the
// raw key — the same behavior the PO implementation had.

import i18next, { type TOptions } from "i18next";
import { setLogTranslator } from "./logMessages";
import { DEFAULT_LANGUAGE, asLanguage, isLanguage, type Language } from "./languages";

export { DEFAULT_LANGUAGE, LANGUAGES, LANGUAGE_INFO, asLanguage, isLanguage } from "./languages";
export type { Language } from "./languages";

const i18n = i18next.createInstance();

/** Unbundled (disk) path first, then the embedded copy in a compiled binary. */
function candidateUrls(lng: Language): URL[] {
	return [
		new URL(`../i18n/${lng}.json`, import.meta.url),
		new URL(`./i18n/${lng}.json`, import.meta.url),
	];
}

const cached = new Map<Language, Record<string, string>>();
const inFlight = new Map<Language, Promise<Record<string, string>>>();

/** The English catalog, loaded once at startup so i18next has a fallback. */
const initGate: Promise<void> = (async () => {
	const en = await readRaw(DEFAULT_LANGUAGE);
	cached.set(DEFAULT_LANGUAGE, en);
	await i18n.init({
		resources: { en: { translation: en } },
		lng: DEFAULT_LANGUAGE,
		fallbackLng: DEFAULT_LANGUAGE,
		// Keys are flat strings that may contain dots, so no path splitting.
		keySeparator: false,
		nsSeparator: false,
		// Positional placeholders: {0}, {1}, ... (escapeValue off — values are
		// plain text, never HTML-escaped by i18next).
		interpolation: { prefix: "{", suffix: "}", escapeValue: false },
		returnNull: false,
	});
})();

export const i18nReady: Promise<void> = initGate;

/**
 * Read a catalog, trying each candidate location in turn.
 * @internal
 */
function readRaw(lng: Language): Promise<Record<string, string>> {
	return (async () => {
		let last: unknown;
		for (const url of candidateUrls(lng)) {
			try {
				return (await Bun.file(url).json()) as Record<string, string>;
			} catch (error) {
				last = error;
			}
		}
		throw last instanceof Error ? last : new Error(`missing i18n catalog for ${lng}`);
	})();
}

/**
 * Load a catalog into i18next, caching it and deduplicating concurrent reads.
 * The default language is served from the cache populated by `initGate`.
 */
function readCatalog(lng: Language): Promise<Record<string, string>> {
	const hit = cached.get(lng);
	if (hit) return Promise.resolve(hit);
	const pending = inFlight.get(lng);
	if (pending) return pending;
	const load = (async () => {
		const bundle = await readRaw(lng);
		cached.set(lng, bundle);
		// Guard i18next's addResourceBundle behind init (the default language
		// is already inside `resources`, so this only runs for other languages).
		await initGate;
		i18n.addResourceBundle(lng, "translation", bundle, true, true);
		return bundle;
	})();
	const tracked = load.finally(() => inFlight.delete(lng));
	inFlight.set(lng, tracked);
	return tracked;
}

/** The language t() currently resolves to; set at startup and on change. */
let current: Language = DEFAULT_LANGUAGE;

/**
 * Switch t() to a language. Synchronous: `current` flips immediately (the
 * default English keeps working as a fallback) while the catalog loads in the
 * background, then i18next is pointed at it once the read settles.
 */
export function setCurrentLanguage(lang: unknown): void {
	current = asLanguage(lang);
	void readCatalog(current)
		.then(() => i18n.changeLanguage(current))
		.catch((error) => console.error(`failed to load i18n catalog for ${current}`, error));
}

/** Maps t(key, a, b) onto i18next's `{0}`, `{1}` interpolation data. */
function interpolate(key: string, args: readonly unknown[], lng?: Language): string {
	const data: Record<string, unknown> = {};
	args.forEach((arg, i) => (data[String(i)] = arg ?? ""));
	return i18n.t(key, { ...(data as object), lng } as TOptions) as string;
}

/**
 * Translate a catalog key into a specific language. Unknown languages fall
 * back to English, unknown keys fall back to English, then to the raw key.
 * `{0}`, `{1}`, ... are replaced by the corresponding arguments.
 */
export function translate(lang: unknown, key: string, ...args: unknown[]): string {
	return interpolate(key, args, asLanguage(lang));
}

/** Translate using the current language. */
export function t(key: string, ...args: unknown[]): string {
	return interpolate(key, args, current);
}

// The log wording (src/logMessages) localizes through the installed translator.
setLogTranslator(t);

/**
 * The catalog for a language, for the device API (src/api.ts) and the control
 * server (server.ts) to serve as /i18n/<lang>.json. Loads on demand and
 * caches. null for unknown codes.
 */
export function catalog(lang: string): Promise<Record<string, string> | null> {
	return isLanguage(lang) ? readCatalog(lang) : Promise.resolve(null);
}
