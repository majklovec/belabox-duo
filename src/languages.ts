// Language metadata shared by every runtime (the Bun i18n core, the browser
// Mithril layer, device state). Kept free of imports so browser bundles can
// reuse it without pulling in the catalog-backed i18next instance.

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
