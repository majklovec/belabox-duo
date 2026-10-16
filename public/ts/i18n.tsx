/* Browser i18n. Runs its own i18next instance whose catalogs are fetched on
 * demand by the i18next-http-backend plugin from /i18n/<lang>.json (served by
 * server.ts / the device API from the embedded catalogs). The plugin loads the
 * current and fallback languages during init and any further language on
 * changeLanguage. The header <LanguageSelect> is the Mithril component that
 * drives the switch: it persists the choice, updates <html lang> and redraws. */
import m from "mithril";
import i18next, { type TOptions } from "i18next";
import httpBackend from "i18next-http-backend";
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

const initPromise = i18n.use(httpBackend).init({
	lng: current,
	fallbackLng: DEFAULT_LANGUAGE,
	backend: {
		// Absolute URL so non-browser fetch (Bun) and cross-origin hosts both
		// work; in the page this is same-origin.
		loadPath: (languages: string[]) =>
			`${window.location.origin}/i18n/${languages[0]}.json`,
		addPath: false,
		reloadInterval: false,
	},
	// Keys are flat strings that may contain dots, so no path splitting.
	keySeparator: false,
	nsSeparator: false,
	// Positional placeholders: {0}, {1}, ... (escapeValue off — the values
	// are plain text and must not be HTML-escaped).
	interpolation: { prefix: "{", suffix: "}", escapeValue: false },
	returnNull: false,
});

/**
 * Resolves once i18next is initialized and the catalogs it loads on init
 * (the selected language plus the English fallback) have settled
 * (mountPage awaits this).
 */
export const i18nReady: Promise<void> = initPromise.then(() =>
	new Promise<void>((resolve, reject) =>
		i18n.loadResources((error) => (error ? reject(error) : resolve())),
	),
).then(() => undefined);

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
	void i18n
		.changeLanguage(current) // the http backend fetches the catalog
		.then(() => m.redraw())
		.catch((error) => console.error(`failed to load i18n catalog for ${current}`, error));
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
