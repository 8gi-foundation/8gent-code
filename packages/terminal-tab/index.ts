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
export {
	deleteSession,
	getSession,
	isPidAlive,
	loadSessions,
	pruneDead,
	saveSession,
	DEFAULT_DIR as SESSIONS_DIR,
} from "./session-store.js";
export type { WindowSession } from "./session-store.js";
export {
	buildOsascript,
	buildWrapperScript,
	focusWindow,
	generateSessionId,
	killSession,
	spawnInWindow,
} from "./window-session.js";
export type { SpawnInWindowOpts, WindowSessionHandle } from "./window-session.js";
export {
	attachInTerminal,
	buildPipePaneArgs,
	buildSendKeysArgs,
	buildTmuxNewSessionArgs,
	hasSession as hasTmuxSession,
	isTmuxAvailable,
	killTmuxSession,
	listTmuxSessions,
	parseLogTail,
	readSessionLog,
	sendKeys as sendTmuxKeys,
	spawnTmuxSession,
	SESSIONS_LOG_DIR,
} from "./tmux-session.js";
export type {
	ParsedLogTail,
	TmuxSessionHandle,
	TmuxSpawnOpts,
} from "./tmux-session.js";
