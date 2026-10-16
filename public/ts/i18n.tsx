/* Browser i18n. Runs its own i18next instance and loads the JSON bundles of
 * the selected languages on demand from /i18n/<lang>.json (served by
 * server.ts / the device API from the embedded catalogs). The header
 * <LanguageSelect> is the Mithril component that drives the switch: it
 * persists the choice, updates <html lang>, fetches the bundle and redraws. */
import m from "mithril";
import i18next, { type TOptions } from "i18next";
import type { MithrilJSXComponent } from "./jsx";
import {
	DEFAULT_LANGUAGE,
	LANGUAGE_INFO,
	LANGUAGES,
	asLanguage,
	type Language,
} from "../../src/languages";
import { setLogTranslator } from "../../src/logMessages";

export { LANGUAGES };
export type { Language };

const STORAGE_KEY = "belabox-lang";

const i18n = i18next.createInstance();

function readInitial(): Language {
	try {
		const stored = localStorage.getItem(STORAGE_KEY);
		if (stored) return asLanguage(stored);
	} catch {
		/* private mode / disabled */
	}
	return asLanguage(document.documentElement.lang);
}

let current: Language = readInitial();
document.documentElement.lang = current;

/** Bundle cache: language codes whose catalog i18next already holds. */
const loaded = new Set<string>();
const inflight = new Map<string, Promise<void>>();

/** fetch /i18n/<lng>.json and hand it to i18next (deduplicated, cached). */
async function loadBundle(lng: Language): Promise<void> {
	if (loaded.has(lng)) return;
	const pending = inflight.get(lng);
	if (pending) return pending;
	const p = (async () => {
		const res = await fetch(`/i18n/${lng}.json`);
		if (!res.ok) throw new Error(`i18n: loading ${lng} failed (${res.status})`);
		const data = (await res.json()) as Record<string, string>;
		i18n.addResourceBundle(lng, "translation", data, true, true);
		loaded.add(lng);
	})();
	inflight.set(lng, p);
	try {
		await p;
	} catch (err) {
		inflight.delete(lng);
		throw err;
	}
}

i18n.init({
	lng: current,
	fallbackLng: DEFAULT_LANGUAGE,
	// Keys are flat strings that may contain dots, so no path splitting.
	keySeparator: false,
	nsSeparator: false,
	// Positional placeholders: {0}, {1}, ... (escapeValue off — the values
	// are plain text and must not be HTML-escaped).
	interpolation: { prefix: "{", suffix: "}", escapeValue: false },
	returnNull: false,
});

/**
 * Resolves once i18next is initialized and both the selected language's
 * bundle and the English fallback are loaded (mountPage awaits this).
 */
export const i18nReady: Promise<void> = (async () => {
	await Promise.all(
		current === (DEFAULT_LANGUAGE as string)
			? [loadBundle(current)]
			: [loadBundle(current), loadBundle(DEFAULT_LANGUAGE as Language)],
	);
})().then(() => undefined);

/** Translate using the current UI language; positional args fill {0}, {1}, ... */
export function t(key: string, ...args: (string | number | undefined)[]): string {
	const data: Record<string, unknown> = {};
	args.forEach((arg, i) => (data[String(i)] = arg ?? ""));
	return i18n.t(key, data as TOptions) as string;
}

// The shared log wording (src/logMessages) localizes through the installed translator.
setLogTranslator((key, ...args) => t(key, ...(args as (string | number | undefined)[])));

/** "🇨🇿 Čeština": flag and native name, the same whatever the UI language. */
export const languageLabel = (l: Language): string => {
	const info = LANGUAGE_INFO.find((i) => i.code === l);
	return info ? `${info.flag} ${info.name}` : l;
};

/** Change the UI language: state, <html lang>, localStorage, bundle, redraw. */
export function setLanguage(next: string): void {
	const value = asLanguage(next);
	if (value === current) return;
	current = value;
	document.documentElement.lang = current;
	try {
		localStorage.setItem(STORAGE_KEY, current);
	} catch {
		/* ignore */
	}
	m.redraw(); // the select updates immediately, before the bundle lands
	void (async () => {
		await loadBundle(current);
		await i18n.changeLanguage(current);
		m.redraw();
	})();
}

/** <option> per language, labelled by its flag and native name. */
export const languageOptions = () =>
	LANGUAGES.map((l) => (
		<option key={l} value={l}>
			{languageLabel(l)}
		</option>
	));

/** Header <select> listing every language by its flag and native name. */
const LanguageSelectComponent: m.Component = {
	view: () => (
		<select
			class={"lang-select"}
			aria-label={t("ui.language_label")}
			value={current}
			onchange={(e: Event) => setLanguage((e.target as HTMLSelectElement).value)}
		>
			{languageOptions()}
		</select>
	),
};

export const LanguageSelect = LanguageSelectComponent as MithrilJSXComponent;
