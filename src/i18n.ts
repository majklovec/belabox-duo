// i18n core. Translations live in i18n/*.po (PO format, English is the source
// of truth); missing keys fall back to English, then to the raw key.
// Positional placeholders: t("x.y", 1, "two") replaces {0}, {1}, ...
//
// t() resolves the language from the module-level current language (see
// setCurrentLanguage). Callers translating into a language other than the
// current one (e.g. the control server logging for a specific device) use
// translate() directly.

// PO files are imported as plain modules: a file path under the Bun runtime,
// an asset URL in the bundled browser pages — i18nReady below loads the text
// from the right source. Entry points (client.ts, server.ts, public/ts/i18n.ts)
// `await ready` before anything calls t().
import cs from "../i18n/cs.po";
import de from "../i18n/de.po";
import en from "../i18n/en.po";
import es from "../i18n/es.po";
import fr from "../i18n/fr.po";
import it from "../i18n/it.po";
import ja from "../i18n/ja.po";
import pl from "../i18n/pl.po";
import pt from "../i18n/pt.po";
import ru from "../i18n/ru.po";
import sk from "../i18n/sk.po";
import zh from "../i18n/zh.po";

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

/** Parsed catalogs: key → translation per language; set by i18nReady. */
let MESSAGES: Record<Language, Record<string, string>> | undefined = undefined;

/**
 * Reads PO text from a module binding — a file path under the Bun runtime,
 * an asset URL once bundled.
 */
async function loadPO(ref: string): Promise<string> {
	if (typeof Bun !== "undefined") return Bun.file(ref).text();
	return (await fetch(ref)).text();
}

/**
 * Loads and parses all catalogs. Entry points (client.ts, server.ts,
 * public/ts/i18n.ts) await this before anything calls t().
 */
export const i18nReady: Promise<void> = (async () => {
	MESSAGES = {
		cs: parsePO(await loadPO(cs)),
		sk: parsePO(await loadPO(sk)),
		pl: parsePO(await loadPO(pl)),
		en: parsePO(await loadPO(en)),
		de: parsePO(await loadPO(de)),
		es: parsePO(await loadPO(es)),
		fr: parsePO(await loadPO(fr)),
		it: parsePO(await loadPO(it)),
		pt: parsePO(await loadPO(pt)),
		ru: parsePO(await loadPO(ru)),
		zh: parsePO(await loadPO(zh)),
		ja: parsePO(await loadPO(ja)),
	};
})();

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
  const messages = MESSAGES;
  if (!messages) return key; // catalogs not loaded yet — entry points await i18nReady
  const language = asLanguage(lang);
  let msg = messages[language][key] ?? messages.en[key];
  if (msg === undefined) return key;
  args.forEach((arg, i) => (msg = msg.replace(`{${i}}`, String(arg ?? ""))));
  return msg;
}

/** Translate using the current language. */
export function t(key: string, ...args: unknown[]): string {
  return translate(current, key, ...args);
}


/**
 * Parses a PO file content string into a record of msgid → msgstr.
 * Skips the header entry (empty msgid) and ignores comments.
 */
export function parsePO(poContent: string): Record<string, string> {
  const lines = poContent.split(/\r?\n/);
  const result: Record<string, string> = {};

  let currentMsgid: string | null = null;
  let currentMsgstr: string | null = null;
  let currentField: 'msgid' | 'msgstr' | null = null;
  let buffer = '';

  // Store the accumulated buffer into the current field and reset it.
  const finishField = () => {
    if (currentField === 'msgid') {
      currentMsgid = buffer;
    } else if (currentField === 'msgstr') {
      currentMsgstr = buffer;
    }
    currentField = null;
    buffer = '';
  };

  // Commit the current msgid/msgstr pair if valid, then reset state.
  const commit = () => {
    finishField();
    if (currentMsgid !== null && currentMsgstr !== null && currentMsgid !== '') {
      result[currentMsgid] = currentMsgstr;
    }
    currentMsgid = null;
    currentMsgstr = null;
  };

  for (const rawLine of lines) {
    const line = rawLine.trim();

    // Empty line: end of an entry
    if (line === '') {
      commit();
      continue;
    }

    // Comments are ignored
    if (line.startsWith('#')) {
      continue;
    }

    // New msgid
    if (line.startsWith('msgid ')) {
      finishField();
      const rest = line.substring(6).trim();
      if (rest) {
        try {
          buffer = JSON.parse(rest);
        } catch {
          // Fallback: strip surrounding quotes
          buffer = rest.replace(/^"|"$/g, '');
        }
      } else {
        buffer = '';
      }
      currentField = 'msgid';
      continue;
    }

    // New msgstr
    if (line.startsWith('msgstr ')) {
      finishField();
      const rest = line.substring(7).trim();
      if (rest) {
        try {
          buffer = JSON.parse(rest);
        } catch {
          buffer = rest.replace(/^"|"$/g, '');
        }
      } else {
        buffer = '';
      }
      currentField = 'msgstr';
      continue;
    }

    // Continuation line (starts with a double quote)
    if (line.startsWith('"')) {
      try {
        const part = JSON.parse(line);
        buffer += part;
      } catch {
        const part = line.replace(/^"|"$/g, '');
        buffer += part;
      }
      continue;
    }

    // Any other line is ignored
  }

  // Commit the last entry (if any)
  commit();

  return result;
}