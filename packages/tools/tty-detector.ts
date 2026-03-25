/**
 * tty-detector.ts
 * Detects terminal capabilities and features at runtime.
 * No deps - pure Node/Bun process inspection.
 */

/** Returns true if stdout is attached to an interactive terminal. */
export function isTTY(): boolean {
  return Boolean(process.stdout.isTTY);
}

/**
 * Color support level:
 *   0 - no color
 *   1 - basic (16 colors, ANSI)
 *   2 - 256 colors
 *   3 - 16 million colors (truecolor)
 */
export function colorLevel(): 0 | 1 | 2 | 3 {
  if (!isTTY()) return 0;
  if (isDumb()) return 0;

  const term = process.env.TERM ?? "";
  const colorterm = (process.env.COLORTERM ?? "").toLowerCase();
  const termProgram = process.env.TERM_PROGRAM ?? "";

  if (colorterm === "truecolor" || colorterm === "24bit") return 3;
  if (termProgram === "iTerm.app") return 3;
  if (termProgram === "Hyper") return 3;
  if (term.includes("256color") || termProgram === "vscode") return 2;
  if (term.includes("color") || term.startsWith("xterm") || term === "screen") return 1;
  if (isCI()) return 1;

  return 0;
}

/** Terminal width in columns. Falls back to 80 if unavailable. */
export function terminalWidth(): number {
  return process.stdout.columns ?? 80;
}

/** Terminal height in rows. Falls back to 24 if unavailable. */
export function terminalHeight(): number {
  return process.stdout.rows ?? 24;
}

/**
 * Returns true if the terminal likely supports OSC 8 hyperlinks.
 * Heuristic-based - no definitive runtime detection exists.
 */
export function supportsHyperlinks(): boolean {
  if (!isTTY()) return false;
  if (isDumb()) return false;

  const termProgram = process.env.TERM_PROGRAM ?? "";
  const vteVersion = process.env.VTE_VERSION;
  const term = process.env.TERM ?? "";

  if (termProgram === "iTerm.app") return true;
  if (termProgram === "Hyper") return true;
  if (termProgram === "vscode") return true;
  if (vteVersion && parseInt(vteVersion, 10) >= 5000) return true;
  if (term.includes("xterm") && colorLevel() >= 2) return true;

  return false;
}

/**
 * Returns true if the terminal likely renders Unicode / emoji correctly.
 * Checks locale and known terminal programs.
 */
export function supportsUnicode(): boolean {
  if (isDumb()) return false;

  const lang = (process.env.LANG ?? "").toLowerCase();
  const lcAll = (process.env.LC_ALL ?? "").toLowerCase();

  if (lang.includes("utf") || lcAll.includes("utf")) return true;

  const termProgram = process.env.TERM_PROGRAM ?? "";
  if (["iTerm.app", "Hyper", "vscode"].includes(termProgram)) return true;

  if (process.env.WT_SESSION) return true;

  return process.platform !== "win32";
}

/**
 * Returns true when running inside a known CI environment.
 * Checks standard CI env flags used by GitHub Actions, CircleCI, etc.
 */
export function isCI(): boolean {
  return Boolean(
    process.env.CI ||
    process.env.CONTINUOUS_INTEGRATION ||
    process.env.GITHUB_ACTIONS ||
    process.env.CIRCLECI ||
    process.env.TRAVIS ||
    process.env.JENKINS_URL ||
    process.env.GITLAB_CI ||
    process.env.BUILDKITE ||
    process.env.TF_BUILD
  );
}

/** Returns true if TERM=dumb - a minimal terminal with no escape sequences. */
export function isDumb(): boolean {
  return process.env.TERM === "dumb";
}

/**
 * Returns a string identifying the terminal emulator in use.
 * Values: "iterm2" | "vscode" | "hyper" | "windows-terminal" | "xterm" | "screen" | "tmux" | "unknown"
 */
export function terminalType(): string {
  const termProgram = process.env.TERM_PROGRAM ?? "";
  const term = process.env.TERM ?? "";

  if (termProgram === "iTerm.app") return "iterm2";
  if (termProgram === "vscode") return "vscode";
  if (termProgram === "Hyper") return "hyper";
  if (process.env.WT_SESSION) return "windows-terminal";
  if (term.startsWith("xterm")) return "xterm";
  if (term === "screen") return "screen";
  if (process.env.TMUX) return "tmux";

  return "unknown";
}
