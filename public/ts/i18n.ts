/* Browser i18n. Reuses the shared catalog (i18n/*.json) and the translation helper in
 * src/i18n; this layer adds the *current* UI language, a header <select>, and redraw.
 *
 * The current language is remembered in localStorage so a page reload keeps the choice;
 * device pages additionally sync the choice to the device's persisted settings (see
 * syncLanguageToServer), where the server is the source of truth on next load. */
import m from "mithril";
import { LANGUAGES, asLanguage, setCurrentLanguage, translate, type Language } from "../../src/i18n";
import en from "../../i18n/en.json";
import cs from "../../i18n/cs.json";

const STORAGE_KEY = "belabox-lang";

const CATALOGS: Record<Language, Record<string, string>> = { en, cs };

let current: Language = readInitial();
setCurrentLanguage(current); // so shared t()/label() resolve to the browser language too
const listeners = new Set<() => void>();

function readInitial(): Language {
	if (typeof localStorage !== "undefined") {
		try {
			const stored = localStorage.getItem(STORAGE_KEY);
			if (stored === "en" || stored === "cs") return stored;
		} catch { /* private mode / disabled */ }
	}
	const html = document.documentElement.lang;
	return html === "cs" ? "cs" : "en";
}

/** A page overrides this to persist the choice (e.g. `settings.update`). Runs async. */
let serverSync: ((lang: Language) => void) | null = null;
export function setServerSync(fn: ((lang: Language) => void) | null): void {
	serverSync = fn;
}

export const lang = (): Language => current;

/** Translate using the current UI language. */
export function t(key: string, ...args: (string | number | undefined)[]): string {
	return translate(current, key, ...args);
}

/** Native display name for a language (in the current UI language). */
export const languageLabel = (l: Language): string => t(`lang.native.${l}`);

/** Change the UI language: state, <html lang>, localStorage, then redraw + async sync. */
export function setLanguage(next: Language | string): void {
	const value = asLanguage(next);
	if (value === current) return;
	current = value;
	setCurrentLanguage(current);
	document.documentElement.lang = current;
	try {
		localStorage.setItem(STORAGE_KEY, current);
	} catch { /* ignore */ }
	for (const fn of listeners) fn();
	m.redraw();
	if (serverSync) void serverSync(value);
}

/** Subscribe to language changes; returns an unsubscribe function. */
export function onChange(fn: () => void): () => void {
	listeners.add(fn);
	return () => {
		listeners.delete(fn);
	};
}

/** Header <select> listing every language by its native name. */
export const LanguageSelect: m.Component = {
	view: () =>
		m(
			"select.lang-select",
			{
				"aria-label": t("ui.language_label"),
				value: current,
				onchange: (e: Event) => setLanguage((e.target as HTMLSelectElement).value),
			},
			LANGUAGES.map((l) => m("option", { key: l, value: l }, languageLabel(l))),
		),
};
