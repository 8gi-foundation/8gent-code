/**
 * shell-escape.ts
 *
 * Safely escapes strings for shell command arguments.
 * Provides command building and shell string splitting utilities.
 *
 * No dependencies. Works on POSIX and Windows (cmd.exe) shells.
 */

/**
 * Characters that require quoting in POSIX shells.
 */
const POSIX_UNSAFE = /[^a-zA-Z0-9@%_\-+=:,./]/;

/**
 * Escape a single argument for use in a POSIX shell command.
 * Returns the argument wrapped in single quotes, with any internal
 * single quotes safely escaped via the '\'' sequence.
 *
 * Empty strings are returned as ''.
 *
 * @example
 * escapeArg("hello world") // => "'hello world'"
 * escapeArg("it's fine")   // => "'it'\\''s fine'"
 * escapeArg("safe123")     // => "safe123"
 */
export function escapeArg(str: string): string {
  if (str === "") return "''";
  if (!POSIX_UNSAFE.test(str)) return str;
  return "'" + str.replace(/'/g, "'\\''") + "'";
}

/**
 * Escape an array of arguments, returning each escaped individually.
 *
 * @example
 * escapeArgs(["git", "commit", "-m", "fix: my bug"])
 * // => ["git", "commit", "-m", "'fix: my bug'"]
 */
export function escapeArgs(args: string[]): string[] {
  return args.map(escapeArg);
}

/**
 * Build a shell command string from a command name and its arguments.
 * Each argument is individually escaped and joined with spaces.
 *
 * @example
 * buildCommand("git", ["commit", "-m", "fix: my bug"])
 * // => "git commit -m 'fix: my bug'"
 */
export function buildCommand(cmd: string, args: string[]): string {
  const escaped = escapeArgs(args);
  return [escapeArg(cmd), ...escaped].join(" ");
}

/**
 * Quote a string for safe embedding inside a double-quoted shell argument.
 * Escapes: backslash, double-quote, dollar-sign, backtick, exclamation.
 *
 * Use this when you need to embed a value inside "..." rather than '...'.
 *
 * @example
 * shellQuote('say "hello" $USER') // => '"say \\"hello\\" \\$USER"'
 */
export function shellQuote(str: string): string {
  const escaped = str
    .replace(/\\/g, "\\\\")
    .replace(/"/g, '\\"')
    .replace(/\$/g, "\\$")
    .replace(/`/g, "\\`")
    .replace(/!/g, "\\!");
  return `"${escaped}"`;
}

type SplitState = "normal" | "single" | "double";

/**
 * Parse a shell command string into an array of arguments.
 * Handles single-quoted, double-quoted, and unquoted tokens.
 * Does NOT expand variables or globs - this is a lexer only.
 *
 * Throws if a quoted section is never closed.
 *
 * @example
 * shellSplit("git commit -m 'fix: my bug'")
 * // => ["git", "commit", "-m", "fix: my bug"]
 *
 * shellSplit('echo "hello world"')
 * // => ["echo", "hello world"]
 */
export function shellSplit(input: string): string[] {
  const args: string[] = [];
  let current = "";
  let state: SplitState = "normal";
  let i = 0;

  while (i < input.length) {
    const ch = input[i];

    if (state === "single") {
      if (ch === "'") {
        state = "normal";
      } else {
        current += ch;
      }
      i++;
      continue;
    }

    if (state === "double") {
      if (ch === '"') {
        state = "normal";
        i++;
        continue;
      }
      if (ch === "\\" && i + 1 < input.length) {
        const next = input[i + 1];
        // Only these chars are special inside double quotes
        if ('"\\$`!'.includes(next)) {
          current += next;
          i += 2;
          continue;
        }
      }
      current += ch;
      i++;
      continue;
    }

    // state === "normal"
    if (ch === " " || ch === "\t" || ch === "\n") {
      if (current.length > 0) {
        args.push(current);
        current = "";
      }
      i++;
      continue;
    }

    if (ch === "'") {
      state = "single";
      i++;
      continue;
    }

    if (ch === '"') {
      state = "double";
      i++;
      continue;
    }

    if (ch === "\\" && i + 1 < input.length) {
      current += input[i + 1];
      i += 2;
      continue;
    }

    current += ch;
    i++;
  }

  if (state === "single") throw new Error("Unterminated single quote in shell string");
  if (state === "double") throw new Error("Unterminated double quote in shell string");

  if (current.length > 0) args.push(current);

  return args;
}
