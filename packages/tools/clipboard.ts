/**
 * Cross-platform clipboard utility for 8gent agents.
 *
 * - copy(text)  - write text to system clipboard
 * - paste()     - read text from system clipboard
 * - history()   - last 10 clipboard items (in-process only)
 *
 * Platform detection: macOS (pbcopy/pbpaste), Linux (xclip), Windows (PowerShell).
 */

import { $ } from "bun";

// ---------------------------------------------------------------------------
// Platform helpers
// ---------------------------------------------------------------------------

type Platform = "darwin" | "linux" | "win32";

function detectPlatform(): Platform {
  const p = process.platform;
  if (p === "darwin" || p === "linux" || p === "win32") return p;
  throw new Error(`Unsupported platform: ${p}`);
}

function copyCmd(platform: Platform): string[] {
  switch (platform) {
    case "darwin":
      return ["pbcopy"];
    case "linux":
      return ["xclip", "-selection", "clipboard"];
    case "win32":
      return ["powershell", "-NoProfile", "-Command", "Set-Clipboard -Value $input"];
  }
}

function pasteCmd(platform: Platform): string[] {
  switch (platform) {
    case "darwin":
      return ["pbpaste"];
    case "linux":
      return ["xclip", "-selection", "clipboard", "-o"];
    case "win32":
      return ["powershell", "-NoProfile", "-Command", "Get-Clipboard"];
  }
}

// ---------------------------------------------------------------------------
// History ring buffer
// ---------------------------------------------------------------------------

const MAX_HISTORY = 10;
const _history: { text: string; timestamp: number }[] = [];

function pushHistory(text: string): void {
  _history.unshift({ text, timestamp: Date.now() });
  if (_history.length > MAX_HISTORY) _history.length = MAX_HISTORY;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/** Copy text to the system clipboard. */
export async function copy(text: string): Promise<void> {
  const platform = detectPlatform();
  const cmd = copyCmd(platform);
  const proc = Bun.spawn(cmd, { stdin: "pipe" });
  proc.stdin.write(text);
  proc.stdin.end();
  const code = await proc.exited;
  if (code !== 0) throw new Error(`Clipboard copy failed (exit ${code})`);
  pushHistory(text);
}

/** Read text from the system clipboard. */
export async function paste(): Promise<string> {
  const platform = detectPlatform();
  const cmd = pasteCmd(platform);
  const proc = Bun.spawn(cmd, { stdout: "pipe" });
  const text = await new Response(proc.stdout).text();
  const code = await proc.exited;
  if (code !== 0) throw new Error(`Clipboard paste failed (exit ${code})`);
  return text;
}

/** Return the last N clipboard items (max 10, in-process only). */
export function history(limit: number = MAX_HISTORY): { text: string; timestamp: number }[] {
  return _history.slice(0, Math.min(limit, MAX_HISTORY));
}
