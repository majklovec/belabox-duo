// i18n core. Translations live in i18n/*.json (English is the source of
// truth); missing keys fall back to English, then to the raw key.
// Positional placeholders: t("x.y", 1, "two") replaces {0}, {1}, ...
//
// t() resolves the language from the module-level current language (see
// setCurrentLanguage). Callers translating into a language other than the
// current one (e.g. the control server logging for a specific device) use
// translate() directly.

import cs from "../i18n/cs.json";
import de from "../i18n/de.json";
import en from "../i18n/en.json";
import es from "../i18n/es.json";
import fr from "../i18n/fr.json";
import it from "../i18n/it.json";
import ja from "../i18n/ja.json";
import pl from "../i18n/pl.json";
import pt from "../i18n/pt.json";
import ru from "../i18n/ru.json";
import sk from "../i18n/sk.json";
import zh from "../i18n/zh.json";

/** Supported languages in menu order, each with its native name and flag. */
export const LANGUAGE_INFO = [
  { code: "cs", name: "Čeština", flag: "🇨🇿" },
  { code: "sk", name: "Slovenčina", flag: "🇸🇰" },
  { code: "pl", name: "Polski", flag: "🇵🇱" },
  { code: "en", name: "English", flag: "🇬🇧" },
  { code: "de", name: "Deutsch", flag: "🇩🇪" },
  { code: "es", name: "Español", flag: "🇪🇸" },
  { code: "fr", name: "Français", flag: "🇫🇷" },
  { code: "it", name: "Italiano", flag: "🇮🇹" },
  { code: "pt", name: "Português", flag: "🇵🇹" },
  { code: "ru", name: "Русский", flag: "🇷🇺" },
  { code: "zh", name: "中文", flag: "🇨🇳" },
  { code: "ja", name: "日本語", flag: "🇯🇵" },
] as const;

export type Language = (typeof LANGUAGE_INFO)[number]["code"];
export const LANGUAGES: readonly Language[] = LANGUAGE_INFO.map((l) => l.code);
export const DEFAULT_LANGUAGE: Language = "en";

export const isLanguage = (value: unknown): value is Language => (LANGUAGES as readonly unknown[]).includes(value);
export const asLanguage = (value: unknown): Language => (isLanguage(value) ? value : DEFAULT_LANGUAGE);

const MESSAGES: Record<Language, Record<string, string>> = { cs, sk, pl, en, de, es, fr, it, pt, ru, zh, ja };

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
