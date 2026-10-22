/**
 * "X is not running; using Y" and "X is not installed, so this session uses Y"
 * are said once per session per fallback, not on every turn (#4754).
 *
 * The readiness effect and the model check re-run on each turn, and on a phone
 * the same line three times in a row buries the reply. The fallback itself is
 * unchanged; only the line is gated. A fallback away from `from` is told again
 * only when its target changes, so a new destination is never silent.
 */
export type FallbackNoticeGate = (from: string, to: string) => boolean;

export function createFallbackNoticeGate(): FallbackNoticeGate {
	const lastTarget = new Map<string, string>();
	return (from, to) => {
		if (lastTarget.get(from) === to) return false;
		lastTarget.set(from, to);
		return true;
	};
}
