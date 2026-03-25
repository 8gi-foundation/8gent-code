/**
 * casing-converter.ts
 * Converts strings between camelCase, snake_case, kebab-case, PascalCase,
 * SCREAMING_SNAKE_CASE, and Title Case with auto-detection.
 */

export type CaseType =
  | "camel"
  | "snake"
  | "kebab"
  | "pascal"
  | "screaming_snake"
  | "title"
  | "unknown";

/**
 * Splits a string into words regardless of its current casing convention.
 */
function tokenize(str: string): string[] {
  // Handle SCREAMING_SNAKE and snake_case
  if (str.includes("_")) {
    return str.split("_").filter(Boolean).map((w) => w.toLowerCase());
  }

  // Handle kebab-case
  if (str.includes("-")) {
    return str.split("-").filter(Boolean).map((w) => w.toLowerCase());
  }

  // Handle camelCase and PascalCase via uppercase boundary splitting
  return str
    .replace(/([A-Z]+)([A-Z][a-z])/g, "$1 $2")
    .replace(/([a-z\d])([A-Z])/g, "$1 $2")
    .trim()
    .split(/\s+/)
    .filter(Boolean)
    .map((w) => w.toLowerCase());
}

/**
 * Detects the case type of a string.
 */
export function detectCase(str: string): CaseType {
  if (!str || typeof str !== "string") return "unknown";

  // SCREAMING_SNAKE: all uppercase with underscores
  if (/^[A-Z][A-Z0-9]*(_[A-Z0-9]+)*$/.test(str)) return "screaming_snake";

  // snake_case: all lowercase with underscores
  if (/^[a-z][a-z0-9]*(_[a-z0-9]+)*$/.test(str) && str.includes("_")) return "snake";

  // kebab-case: all lowercase with hyphens
  if (/^[a-z][a-z0-9]*(-[a-z0-9]+)*$/.test(str)) return "kebab";

  // PascalCase: starts with uppercase, no separators
  if (/^[A-Z][a-zA-Z0-9]*$/.test(str) && /[a-z]/.test(str)) return "pascal";

  // camelCase: starts with lowercase, contains uppercase
  if (/^[a-z][a-zA-Z0-9]*$/.test(str) && /[A-Z]/.test(str)) return "camel";

  // Title Case: words separated by spaces, each capitalised
  if (/^[A-Z][a-z]*( [A-Z][a-z]*)*$/.test(str)) return "title";

  return "unknown";
}

/**
 * Converts a string to camelCase.
 * Example: "hello_world" -> "helloWorld"
 */
export function toCamel(str: string): string {
  const words = tokenize(str);
  return words
    .map((word, i) => (i === 0 ? word : word[0].toUpperCase() + word.slice(1)))
    .join("");
}

/**
 * Converts a string to snake_case.
 * Example: "helloWorld" -> "hello_world"
 */
export function toSnake(str: string): string {
  return tokenize(str).join("_");
}

/**
 * Converts a string to kebab-case.
 * Example: "helloWorld" -> "hello-world"
 */
export function toKebab(str: string): string {
  return tokenize(str).join("-");
}

/**
 * Converts a string to PascalCase.
 * Example: "hello_world" -> "HelloWorld"
 */
export function toPascal(str: string): string {
  return tokenize(str)
    .map((word) => word[0].toUpperCase() + word.slice(1))
    .join("");
}

/**
 * Converts a string to SCREAMING_SNAKE_CASE.
 * Example: "helloWorld" -> "HELLO_WORLD"
 */
export function toScreamingSnake(str: string): string {
  return tokenize(str).join("_").toUpperCase();
}

/**
 * Converts a string to Title Case.
 * Example: "hello_world" -> "Hello World"
 */
export function toTitle(str: string): string {
  return tokenize(str)
    .map((word) => word[0].toUpperCase() + word.slice(1))
    .join(" ");
}

/**
 * Converts a string from one case to another.
 * If `from` is omitted, it is auto-detected.
 *
 * @param str   - The input string
 * @param to    - The target case type
 * @param from  - The source case type (optional, auto-detected if omitted)
 */
export function convert(str: string, to: CaseType, from?: CaseType): string {
  // `from` is used only for documentation / caller intent; tokenize() handles any input format.
  void from;

  switch (to) {
    case "camel":           return toCamel(str);
    case "snake":           return toSnake(str);
    case "kebab":           return toKebab(str);
    case "pascal":          return toPascal(str);
    case "screaming_snake": return toScreamingSnake(str);
    case "title":           return toTitle(str);
    default:
      throw new Error(`Unknown target case: ${to}`);
  }
}
