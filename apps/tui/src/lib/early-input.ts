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
 */

const stdin = process.stdin as NodeJS.ReadStream & { setRawMode?: (mode: boolean) => void };

export const EARLY_RAW =
	Boolean(stdin.isTTY) &&
	typeof stdin.setRawMode === "function" &&
	process.env["8GENT_EARLY_RAW"] !== "0";

if (EARLY_RAW) {
	try {
		stdin.setRawMode?.(true);
		process.once("exit", () => {
			try {
				if (stdin.isRaw) stdin.setRawMode?.(false);
			} catch {
				// The terminal is already gone.
			}
		});
	} catch {
		// Not a real tty after all: nothing to hold.
	}
}
