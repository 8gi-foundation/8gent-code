/**
 * @8gent/terminal-tab — public exports.
 *
 * Used by:
 *   - apps/tui/src/hooks/useTerminal.ts (via PtySession + ansi-strip + RingBuffer)
 *   - future /term command in app.tsx
 */

export { PtySession } from "./pty-session.js";
export type { PtySessionOpts, DataHandler, ExitHandler } from "./pty-session.js";
export { stripControl, hasAltScreenEnter, hasAltScreenExit } from "./ansi-strip.js";
export { RingBuffer } from "./ring-buffer.js";
export { findNodeBinary } from "./find-node.js";
export { resolveTermCommand } from "./command-resolver.js";
export type { ResolvedTermCommand, PresetEntry, ResolveOpts } from "./command-resolver.js";
