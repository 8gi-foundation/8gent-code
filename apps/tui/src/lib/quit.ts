/**
 * Ctrl+C must always end the process (pilot break 13).
 *
 * Ink's exit() only unmounts the screen. A turn that is still waiting on a
 * model (a 27B reasoning for minutes) keeps its request, its timers and the
 * agent loop alive, so the terminal froze on the last frame for about 78 s
 * and the turn went on running, even calling tools, after the person quit.
 *
 * So quitting does three things in order: stop every in-flight turn, unmount,
 * then arm a hard process exit that nothing in the agent can hold open.
 */

export const QUIT_GRACE_MS = 1500;

export interface QuitDeps {
	/** Abort every in-flight turn, on every tab. Must not throw past here. */
	abortAll: () => void;
	/** Ink's exit(): unmounts the tree. */
	unmount: () => void;
	/** process.exit by default; injected in tests. */
	hardExit?: (code: number) => void;
	/** setTimeout by default; injected in tests. */
	schedule?: (fn: () => void, ms: number) => unknown;
	graceMs?: number;
}

export function quitNow(deps: QuitDeps): void {
	const hardExit = deps.hardExit ?? ((code: number) => process.exit(code));
	const schedule = deps.schedule ?? ((fn, ms) => setTimeout(fn, ms));
	try {
		deps.abortAll();
	} catch {
		// A failing abort must never keep the person in the program.
	}
	try {
		deps.unmount();
	} catch {
		hardExit(0);
		return;
	}
	schedule(() => hardExit(0), deps.graceMs ?? QUIT_GRACE_MS);
}
