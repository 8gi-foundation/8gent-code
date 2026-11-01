/**
 * A terminal that reports no size, or 0 by 0, must not blank the first screen
 * (#4540). Components read `stdout.columns ?? 80`, which keeps an undefined
 * size but treats 0 as a real width and lays out into nothing. SSH clients,
 * ConPTY and pseudo terminals that have not been sized yet report 0 by 0.
 * Before the first render, replace a missing or non-positive size with 80 by
 * 24. The property stays writable, so the stream's own resize handling still
 * overwrites it as soon as the terminal reports a real size.
 */
export const FALLBACK_COLUMNS = 80;
export const FALLBACK_ROWS = 24;

interface SizedStream {
	columns?: number;
	rows?: number;
	isTTY?: boolean;
}

const bad = (n: unknown) => typeof n !== "number" || !Number.isFinite(n) || n <= 0;

/** Returns true when it had to supply a fallback. Never throws. */
export function ensureTerminalSize(stdout: SizedStream = process.stdout as SizedStream): boolean {
	if (!stdout.isTTY) return false;
	let patched = false;
	for (const [key, fallback] of [
		["columns", FALLBACK_COLUMNS],
		["rows", FALLBACK_ROWS],
	] as const) {
		if (!bad(stdout[key])) continue;
		try {
			Object.defineProperty(stdout, key, {
				value: fallback,
				writable: true,
				configurable: true,
				enumerable: true,
			});
			patched = true;
		} catch {
			// A frozen stream: nothing to do, the component defaults apply.
		}
	}
	return patched;
}
