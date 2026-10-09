/* Browser i18n. Reuses the shared catalog and translation helper in src/i18n; this layer
 * adds the *current* UI language (remembered in localStorage), a header <select>, and redraw. */
import m from "mithril";
import type { MithrilJSXComponent } from "./jsx";
import {
	asLanguage,
	i18nReady,
	LANGUAGE_INFO,
	LANGUAGES,
	type Language,
	setCurrentLanguage,
	translate,
} from "../../src/i18n";

export { LANGUAGES, i18nReady };
export type { Language };

const STORAGE_KEY = "belabox-lang";

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
setCurrentLanguage(current); // so shared t()/label() resolve to the browser language too
document.documentElement.lang = current;

/** Translate using the current UI language. */
export function t(key: string, ...args: (string | number | undefined)[]): string {
	return translate(current, key, ...args);
}

/** "🇨🇿 Čeština": flag and native name, the same whatever the UI language. */
export const languageLabel = (l: Language): string => {
	const info = LANGUAGE_INFO.find((i) => i.code === l);
	return info ? `${info.flag} ${info.name}` : l;
};

/** Change the UI language: state, <html lang>, localStorage, then redraw. */
export function setLanguage(next: string): void {
	const value = asLanguage(next);
	if (value === current) return;
	current = value;
	setCurrentLanguage(current);
	document.documentElement.lang = current;
	try {
		localStorage.setItem(STORAGE_KEY, current);
	} catch {
		/* ignore */
	}
	m.redraw();
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
