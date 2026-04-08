/**
 * @8gent/tools - i18n utility
 *
 * Internationalization with JSON translation files, string interpolation,
 * pluralization, and locale detection. ~100 lines, zero dependencies.
 */

import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";

export type TranslationMap = Record<string, string | Record<string, string>>;
export type Locale = string; // e.g. "en", "pt-BR", "ja"

export interface I18nOptions {
  /** Directory containing locale JSON files (e.g. en.json, pt-BR.json) */
  localesDir: string;
  /** Fallback locale when key is missing in active locale */
  fallback?: Locale;
  /** Override auto-detected locale */
  locale?: Locale;
}

export class I18n {
  private catalogs = new Map<Locale, TranslationMap>();
  private locale: Locale;
  private fallback: Locale;
  private localesDir: string;

  constructor(opts: I18nOptions) {
    this.localesDir = opts.localesDir;
    this.fallback = opts.fallback ?? "en";
    this.locale = opts.locale ?? detectLocale();
    this.load(this.fallback);
    if (this.locale !== this.fallback) this.load(this.locale);
  }

  /** Load a locale JSON file into memory. */
  load(locale: Locale): void {
    if (this.catalogs.has(locale)) return;
    const file = join(this.localesDir, `${locale}.json`);
    if (!existsSync(file)) return;
    const data = JSON.parse(readFileSync(file, "utf-8")) as TranslationMap;
    this.catalogs.set(locale, data);
  }

  /** Get the active locale. */
  getLocale(): Locale {
    return this.locale;
  }

  /** Switch active locale at runtime. */
  setLocale(locale: Locale): void {
    this.locale = locale;
    this.load(locale);
  }

  /**
   * Translate a key with optional interpolation and pluralization.
   *
   * Interpolation: `t("hello", { name: "James" })` with `"hello": "Hi {{name}}"`
   * Pluralization: key maps to `{ "one": "1 item", "other": "{{count}} items" }`
   *               call `t("items", { count: 5 })`
   */
  t(key: string, vars?: Record<string, string | number>): string {
    const raw = this.resolve(key, this.locale) ?? this.resolve(key, this.fallback);
    if (raw === undefined) return key;

    // Pluralization - value is an object with plural forms
    if (typeof raw === "object") {
      const count = vars?.count ?? 0;
      const form = pluralForm(Number(count));
      const template = raw[form] ?? raw["other"] ?? Object.values(raw)[0] ?? key;
      return interpolate(template, vars);
    }

    return interpolate(raw, vars);
  }

  /** Check if a key exists in the active locale or fallback. */
  has(key: string): boolean {
    return (
      this.resolve(key, this.locale) !== undefined ||
      this.resolve(key, this.fallback) !== undefined
    );
  }

  /** List all loaded locales. */
  locales(): Locale[] {
    return [...this.catalogs.keys()];
  }

  private resolve(key: string, locale: Locale): string | Record<string, string> | undefined {
    const catalog = this.catalogs.get(locale);
    if (!catalog) return undefined;
    // Support dot-notation: "errors.notFound"
    const parts = key.split(".");
    let current: unknown = catalog;
    for (const part of parts) {
      if (current === null || typeof current !== "object") return undefined;
      current = (current as Record<string, unknown>)[part];
    }
    if (typeof current === "string") return current;
    if (typeof current === "object" && current !== null) return current as Record<string, string>;
    return undefined;
  }
}

/** Replace `{{var}}` placeholders with values. */
function interpolate(template: string, vars?: Record<string, string | number>): string {
  if (!vars) return template;
  return template.replace(/\{\{(\w+)\}\}/g, (_, name) => {
    const val = vars[name];
    return val !== undefined ? String(val) : `{{${name}}}`;
  });
}

/** English-style plural form selection. */
function pluralForm(count: number): string {
  if (count === 0) return "zero";
  if (count === 1) return "one";
  if (count === 2) return "two";
  return "other";
}

/** Detect locale from environment. */
export function detectLocale(): Locale {
  const env = process.env.LANG ?? process.env.LC_ALL ?? process.env.LANGUAGE ?? "en";
  // LANG is typically "en_US.UTF-8" - extract the language part
  const match = env.match(/^([a-z]{2}(?:[_-][A-Z]{2})?)/i);
  if (!match) return "en";
  return match[1].replace("_", "-");
}
