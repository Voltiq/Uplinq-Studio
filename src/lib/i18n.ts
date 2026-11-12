/*
 * Translation. English is the language the interface is written in; the
 * English text is also the key. `t("Connect to {0}", host)` gives the text in
 * the language in use, or the English when a translation is missing.
 * Placeholders are numbered: t("{0} of {1}", 3, 12).
 *
 * The language is fixed when the app starts (from Settings, or from
 * Windows), because labels are also built once when the modules load.
 * Changing it in Settings applies at the next start.
 */

import { de } from "./de";

export type Language = "en" | "de";
const LANGUAGES: Language[] = ["en", "de"];

/** Where Settings are kept (see storage.ts); read here directly so the language is known before anything renders. */
const SETTINGS_KEY = "ftp-studio.settings.v1";

function detect(): Language {
  let preference = "system";
  try {
    preference = (JSON.parse(localStorage.getItem(SETTINGS_KEY) ?? "{}") as { language?: string }).language ?? "system";
  } catch {
    // No settings yet: follow the system.
  }
  if (LANGUAGES.includes(preference as Language)) return preference as Language;
  const system = (typeof navigator === "undefined" ? "en" : navigator.language).slice(0, 2).toLowerCase();
  return LANGUAGES.includes(system as Language) ? (system as Language) : "en";
}

let language: Language = detect();
const tables: Record<Language, Record<string, string>> = { en: {}, de };

if (typeof document !== "undefined") document.documentElement.lang = language;

export function currentLanguage(): Language {
  return language;
}

/** For tests. */
export function setLanguage(l: Language) {
  language = l;
}

export function t(text: string, ...args: (string | number | null | undefined)[]): string {
  const found = tables[language][text] ?? text;
  return args.length ? found.replace(/\{(\d+)\}/g, (_, i) => String(args[Number(i)] ?? "")) : found;
}

/**
 * Text that comes from the Rust side (connection and file errors). It is
 * written in English; sentences the table knows are shown translated, with
 * their numbers and quoted names put back in. Unknown text stays English.
 */
export function te(text: string): string {
  if (language === "en" || !text) return text;
  const table = tables[language];
  const direct = table[text];
  if (direct) return direct;

  // "Can't read “docs”." matches the key "Can't read {0}.": numbers and quoted names are
  // placeholders. A quoted name the table knows (a setting, say) is translated as well.
  const args: string[] = [];
  const key = text.replace(/“[^”]*”|0x[0-9a-f]+|\d+(?:[.,]\d+)?/gi, (m) => {
    args.push(m);
    return `{${args.length - 1}}`;
  });
  const found = table[key];
  if (found) {
    return found.replace(/\{(\d+)\}/g, (_, i) => {
      const arg = args[Number(i)] ?? "";
      const inner = /^“(.*)”$/.exec(arg)?.[1];
      return inner && table[inner] ? `„${table[inner]}“` : inner != null ? `„${inner}“` : arg;
    });
  }

  // Details from the server or Windows at the end, "… password. (530 Login incorrect.)":
  // the sentence is translated, the details stay as they came.
  const tail = /^(.*\S)\s*\(([^()]*)\)(\.?)$/.exec(text);
  if (tail) {
    const sentence = tail[1].endsWith(".") ? tail[1] : `${tail[1]}${tail[3]}`;
    const translated = te(sentence);
    if (translated !== sentence) return `${translated} (${tail[2]})`;
  }

  // "Network error: connection reset" matches the key "Network error: {0}".
  const colon = /^([^:]{3,}): (.+)$/s.exec(text);
  if (colon) {
    const head = table[`${colon[1]}: {0}`];
    if (head) return head.replace("{0}", te(colon[2]));
  }
  return text;
}
