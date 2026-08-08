import type { Locale } from "../shared/types.js";

export function normalizeLocale(value: unknown): Locale {
  return value === "en" ? "en" : "es";
}

export function localized(locale: Locale | undefined, spanish: string, english: string) {
  return normalizeLocale(locale) === "en" ? english : spanish;
}
