/**
 * Take the terminal out of line mode the moment the process starts, before
 * the heavy module graph loads (#3159).
 *
 * Why: the TUI takes 0.6 to 1.0 s to paint its first frame. A key pressed in
 * that window used to be echoed onto the screen by the terminal's line
 * discipline and held until Enter, so it never reached the splash: the
 * splash ran its full course although the person had already pressed a key.
 * In raw mode the key is neither echoed nor held back; the bytes wait in the
 * tty until Ink starts reading, and the splash sees them as its first input.
 *
 * Nothing reads stdin here, so no byte is consumed. Imported first by
 * index.tsx; ES modules evaluate in import order, so this runs before Ink and
 * the app are even loaded. Line mode is restored on exit in case Ink never
 * mounts (a crash during load), so the shell is never left raw.
 *
 * #4540 (the first moment must never be blank or frozen):
 * - On win32 the hand-off is skipped unless 8GENT_EARLY_RAW=1: Bun raw mode on
 *   Windows terminals is the top suspect for a screen that never moves.
 * - A watchdog: if raw mode was entered and, WATCHDOG_MS later, Ink has not
 *   mounted and no key has arrived, stdin is handed back (raw off, resumed)
 *   and the normal path continues. One boot-trace line records it.
 */
import { bootTrace } from "./boot-trace.js";

export const WATCHDOG_MS = 1500;

export interface EarlyInputStdin {
	isTTY?: boolean;
	isRaw?: boolean;
	readableLength?: number;
	setRawMode?: (mode: boolean) => unknown;
	resume?: () => unknown;
}

export interface EarlyInputDeps {
	stdin: EarlyInputStdin;
	platform: string;
	env: Record<string, string | undefined>;
	trace: (line: string) => void;
	setTimer: (fn: () => void, ms: number) => unknown;
	clearTimer: (t: unknown) => void;
}

export interface EarlyInputHandle {
	raw: boolean;
	/** Ink has mounted: the watchdog is no longer needed. */
	markMounted: () => void;
}

/** Whether the early raw-mode hand-off should happen at all. */
export function earlyRawDecision(
	stdin: EarlyInputStdin,
	platform: string,
	env: Record<string, string | undefined>,
): "raw" | "off" | "win32-skip" {
	if (!stdin.isTTY || typeof stdin.setRawMode !== "function") return "off";
	if (env["8GENT_EARLY_RAW"] === "0") return "off";
	if (platform === "win32" && env["8GENT_EARLY_RAW"] !== "1") return "win32-skip";
	return "raw";
}

export function armEarlyInput(deps: EarlyInputDeps): EarlyInputHandle {
	const { stdin, platform, env, trace } = deps;
	const decision = earlyRawDecision(stdin, platform, env);
	if (decision === "win32-skip") {
		trace("early-raw skipped on win32 (set 8GENT_EARLY_RAW=1 to force)");
		return { raw: false, markMounted() {} };
	}
	if (decision === "off") return { raw: false, markMounted() {} };

	try {
		stdin.setRawMode?.(true);
	} catch {
		// Not a real tty after all: nothing to hold.
		return { raw: false, markMounted() {} };
	}
	const timer = deps.setTimer(() => {
		// A key waiting in the tty means the hand-off is doing its job.
		if ((stdin.readableLength ?? 0) > 0) return;
		try {
			if (stdin.isRaw) stdin.setRawMode?.(false);
			stdin.resume?.();
			trace(`watchdog: no key and no Ink mount in ${WATCHDOG_MS} ms, stdin restored`);
		} catch {
			// The terminal is already gone.
		}
	}, WATCHDOG_MS);
	return {
		raw: true,
		markMounted() {
			deps.clearTimer(timer);
		},
	};
}

const realStdin = process.stdin as NodeJS.ReadStream;

const handle = armEarlyInput({
	stdin: realStdin,
	platform: process.platform,
	env: process.env,
	trace: bootTrace,
	setTimer: (fn, ms) => {
		const t = setTimeout(fn, ms);
		(t as { unref?: () => void }).unref?.();
		return t;
	},
	clearTimer: (t) => clearTimeout(t as ReturnType<typeof setTimeout>),
});

export const EARLY_RAW = handle.raw;
export const markInkMounted = handle.markMounted;

if (EARLY_RAW) {
	process.once("exit", () => {
		try {
			if (realStdin.isRaw) realStdin.setRawMode?.(false);
		} catch {
			// The terminal is already gone.
		}
	});
}
