// i18n core. Translations live in i18n/*.json (English is the source of
// truth); missing keys fall back to English, then to the raw key.
// Positional placeholders: t("x.y", 1, "two") replaces {0}, {1}, ...
//
// t() resolves the language from the module-level current language (see
// setCurrentLanguage). Callers translating into a language other than the
// current one (e.g. the control server logging for a specific device) use
// translate() directly.

import en from "../i18n/en.json";
import cs from "../i18n/cs.json";

export const LANGUAGES = ["en", "cs"] as const;
export type Language = (typeof LANGUAGES)[number];
export const DEFAULT_LANGUAGE: Language = "en";

export const isLanguage = (value: unknown): value is Language => (LANGUAGES as readonly unknown[]).includes(value);
export const asLanguage = (value: unknown): Language => (isLanguage(value) ? value : DEFAULT_LANGUAGE);

const MESSAGES: Record<Language, Record<string, string>> = { en, cs };

/** The language t()/label() currently resolve to; set at startup and on change. */
let current: Language = DEFAULT_LANGUAGE;

export function setCurrentLanguage(lang: unknown): void {
  current = asLanguage(lang);
}

/**
 * Translate a catalog key into a specific language. Unknown languages fall
 * back to English, unknown keys fall back to English, then to the raw key.
 * `{0}`, `{1}`, ... are replaced by the corresponding arguments.
 */
export function translate(lang: unknown, key: string, ...args: unknown[]): string {
  let msg = MESSAGES[asLanguage(lang)][key] ?? MESSAGES.en[key];
  if (msg === undefined) return key;
  args.forEach((arg, i) => (msg = msg.replace(`{${i}}`, String(arg ?? ""))));
  return msg;
}

/** Translate using the current language. */
export function t(key: string, ...args: unknown[]): string {
  return translate(current, key, ...args);
}
