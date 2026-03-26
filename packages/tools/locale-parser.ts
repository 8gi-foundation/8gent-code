/**
 * Parse and normalize BCP 47 locale strings.
 */
export class Bcp47 {
  /**
   * Parse a BCP 47 locale string.
   * @param locale - The locale string to parse.
   * @returns Parsed locale components.
   */
  static parse(locale: string): { language: string; script?: string; region?: string; variants?: string[] } {
    const parts = locale.split('-');
    const language = parts[0];
    const script = parts.length > 1 && this.isScript(parts[1]) ? parts[1] : undefined;
    const region = parts.length > (script ? 2 : 1) && this.isRegion(parts[script ? 2 : 1]) ? parts[script ? 2 : 1] : undefined;
    const variants = parts.slice(script ? 3 : 2).filter(v => this.isVariant(v));
    return { language, script, region, variants };
  }

  /**
   * Normalize a locale string to its canonical form.
   * @param locale - The locale string to normalize.
   * @returns Normalized locale string.
   */
  static normalize(locale: string): string {
    const { language, script, region, variants } = this.parse(locale);
    const normalized = [language.toLowerCase()];
    if (script) normalized.push(script.toUpperCase());
    if (region) normalized.push(region.toUpperCase());
    if (variants) normalized.push(...variants.map(v => v.toLowerCase()));
    return normalized.join('-');
  }

  /**
   * Check if a locale string is valid BCP 47 format.
   * @param locale - The locale string to validate.
   * @returns True if valid, false otherwise.
   */
  static isValid(locale: string): boolean {
    const parts = locale.split('-');
    if (parts.length < 1 || !this.isLanguage(parts[0])) return false;
    for (let i = 1; i < parts.length; i++) {
      if (i === 1 && this.isScript(parts[i])) continue;
      if (i === 1 && this.isRegion(parts[i])) continue;
      if (i > 1 && this.isVariant(parts[i])) continue;
      return false;
    }
    return true;
  }

  /**
   * Find the best matching locale from available options.
   * @param requested - Array of requested locales.
   * @param available - Array of available locales.
   * @returns Best matching locale or undefined.
   */
  static match(requested: string[], available: string[]): string | undefined {
    for (const r of requested) {
      for (const a of available) {
        if (r === a) return r;
        const rParts = r.split('-'), aParts = a.split('-');
        if (rParts[0] === aParts[0] && (rParts.length === 1 || (rParts.length > 1 && rParts[1] === aParts[1]))) {
          return a;
        }
      }
    }
    return undefined;
  }

  private static isLanguage(s: string): boolean { return /^[a-z]{2,3}$/.test(s); }
  private static isScript(s: string): boolean { return /^[A-Z]{4}$/.test(s); }
  private static isRegion(s: string): boolean { return /^[A-Z]{2,3}$/.test(s); }
  private static isVariant(s: string): boolean { return /^[a-z]{1,8}$/.test(s); }
}