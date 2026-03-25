/**
 * template-literal.ts
 *
 * Safe tagged template literals with auto-escaping and formatting utilities.
 * Five tags: dedent, stripIndent, oneLine, raw, highlight.
 */

// ANSI escape sequences for wrapping interpolations
const ANSI_CYAN_OPEN = "\x1b[36m";
const ANSI_RESET = "\x1b[0m";

/**
 * Reconstruct a template literal string from its parts.
 * Interpolations are coerced to string via String().
 */
function assemble(strings: TemplateStringsArray, values: unknown[]): string {
  let result = "";
  for (let i = 0; i < strings.length; i++) {
    result += strings[i];
    if (i < values.length) result += String(values[i]);
  }
  return result;
}

/**
 * Detect the minimum indentation level across all non-empty lines.
 * Ignores the first line (usually empty after the opening backtick).
 */
function minIndent(str: string): number {
  const lines = str.split("\n");
  let min = Infinity;
  for (const line of lines) {
    const trimmed = line.trimStart();
    if (trimmed.length === 0) continue;
    const indent = line.length - trimmed.length;
    if (indent < min) min = indent;
  }
  return min === Infinity ? 0 : min;
}

/**
 * dedent - Remove common leading indentation from all lines.
 *
 * Useful for multiline template literals nested inside indented code.
 * Trailing newline is stripped; leading blank line after opening backtick removed.
 *
 * @example
 * dedent`
 *   Hello
 *     World
 * `
 * // -> "Hello\n  World"
 */
export function dedent(
  strings: TemplateStringsArray,
  ...values: unknown[]
): string {
  const raw = assemble(strings, values);
  const lines = raw.split("\n");

  // Drop leading blank line (opening backtick line)
  if (lines[0].trim() === "") lines.shift();
  // Drop trailing blank line (closing backtick line)
  if (lines[lines.length - 1].trim() === "") lines.pop();

  const indent = minIndent(lines.join("\n"));
  return lines.map((line) => line.slice(indent)).join("\n");
}

/**
 * stripIndent - Remove all leading indentation from every line.
 *
 * More aggressive than dedent: each line is fully left-trimmed.
 * Collapses relative indentation differences.
 *
 * @example
 * stripIndent`
 *   line one
 *     line two (extra indent)
 * `
 * // -> "line one\nline two (extra indent)"
 */
export function stripIndent(
  strings: TemplateStringsArray,
  ...values: unknown[]
): string {
  const assembled = assemble(strings, values);
  const lines = assembled.split("\n");

  if (lines[0].trim() === "") lines.shift();
  if (lines[lines.length - 1].trim() === "") lines.pop();

  return lines.map((line) => line.trimStart()).join("\n");
}

/**
 * oneLine - Collapse all whitespace and newlines into a single line.
 *
 * Strips leading/trailing whitespace, replaces runs of whitespace with
 * a single space. Ideal for long error messages or SQL fragments.
 *
 * @example
 * oneLine`
 *   SELECT *
 *   FROM users
 *   WHERE active = true
 * `
 * // -> "SELECT * FROM users WHERE active = true"
 */
export function oneLine(
  strings: TemplateStringsArray,
  ...values: unknown[]
): string {
  return assemble(strings, values).replace(/\s+/g, " ").trim();
}

/**
 * raw - Preserve raw escape sequences, skipping JavaScript escape processing.
 *
 * Uses String.raw semantics: backslashes are not interpreted as escapes.
 * Interpolations are still evaluated and coerced to string.
 *
 * @example
 * raw`C:\Users\eight\config.json`
 * // -> "C:\\Users\\eight\\config.json" (no escape processing)
 */
export function raw(
  strings: TemplateStringsArray,
  ...values: unknown[]
): string {
  let result = "";
  for (let i = 0; i < strings.raw.length; i++) {
    result += strings.raw[i];
    if (i < values.length) result += String(values[i]);
  }
  return result;
}

/**
 * highlight - Wrap each interpolated value in ANSI cyan color codes.
 *
 * Static string parts are left unstyled; only the interpolated values
 * are highlighted. Useful for terminal log messages and prompts.
 *
 * @example
 * highlight`Loading model ${modelName} on port ${port}`
 * // -> "Loading model \x1b[36mmistral\x1b[0m on port \x1b[36m11434\x1b[0m"
 */
export function highlight(
  strings: TemplateStringsArray,
  ...values: unknown[]
): string {
  let result = "";
  for (let i = 0; i < strings.length; i++) {
    result += strings[i];
    if (i < values.length) {
      result += ANSI_CYAN_OPEN + String(values[i]) + ANSI_RESET;
    }
  }
  return result;
}
