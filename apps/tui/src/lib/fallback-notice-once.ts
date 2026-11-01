/**
 * "X is not running; using Y" and "X is not installed, so this session uses Y"
 * are said once per session per fallback, not on every turn (#4754).
 *
 * The readiness effect and the model check re-run on each turn, and on a phone
 * the same line three times in a row buries the reply. The fallback itself is
 * unchanged; only the line is gated. A fallback away from `from` is told again
 * only when its target changes, so a new destination is never silent.
 */
export type FallbackNoticeGate = ((from: string, to: string) => boolean) & {
	/**
	 * Forget the last target for `from`. Called when `from` checks healthy, so a
	 * later fallback to the same target is told again: each local-to-cloud move
	 * sends data off the machine and must be visible (#4787).
	 */
	clear: (from: string) => void;
};

export function createFallbackNoticeGate(): FallbackNoticeGate {
	const lastTarget = new Map<string, string>();
	const gate = (from: string, to: string) => {
		if (lastTarget.get(from) === to) return false;
		lastTarget.set(from, to);
		return true;
	};
	return Object.assign(gate, { clear: (from: string) => void lastTarget.delete(from) });
}
