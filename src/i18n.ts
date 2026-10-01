// i18n core. Translations live in i18n/*.json (English is the source of
// truth); missing keys fall back to English, then to the raw key.
// Positional placeholders: t("x.y", 1, "two") replaces {0}, {1}, ...
//
// t() resolves the language itself from the module-level current language
// (see setCurrentLanguage / getCurrentLanguage). Callers translating into a
// language other than the current one (e.g. the control server logging for a
// specific device) use translate() directly.

import en from "../i18n/en.json";
import cs from "../i18n/cs.json";

export type Language = "en" | "cs";

export const LANGUAGES: readonly Language[] = ["en", "cs"];

export const DEFAULT_LANGUAGE: Language = "en";

export function asLanguage(value: unknown): Language {
  return value === "cs" ? "cs" : "en";
}

type Messages = Record<string, string>;

const EN: Messages = en;
const CS: Messages = cs;
const MESSAGES: Record<Language, Messages> = { en: EN, cs: CS };

/** The language t()/label() currently resolve to; set at startup and on change. */
let current: Language = DEFAULT_LANGUAGE;

export function setCurrentLanguage(lang: Language | unknown): void {
  current = asLanguage(lang);
}

export function getCurrentLanguage(): Language {
  return current;
}

/**
 * Translate a catalog key into a specific language. Unknown languages fall
 * back to English, unknown keys fall back to English, then to the raw key.
 * `{0}`, `{1}`, ... are replaced by the corresponding arguments.
 */
export function translate(lang: Language | unknown, key: string, ...args: unknown[]): string {
  const table = MESSAGES[asLanguage(lang)];
  let msg = table[key] ?? EN[key];
  if (msg === undefined) return key;
  for (let i = 0; i < args.length; i++) {
    msg = msg.replace(`{${i}}`, String(args[i] ?? ""));
  }
  return msg;
}

/** Translate using the current language. */
export function t(key: string, ...args: unknown[]): string {
  return translate(current, key, ...args);
}
