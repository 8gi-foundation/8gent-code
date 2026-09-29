/**
 * The HUD motion language (design: ~/.8gent/evidence/hud-design/MOTION.md).
 *
 * Rules every motion here follows:
 * - It marks a change of state and resolves into stillness. Nothing loops.
 * - It is short: every burst ends within MOTION_BUDGET_MS.
 * - It never delays input: motions are display state only, and a new state
 *   change mid-motion starts from wherever the motion is.
 * - It is off when animations are off (Ctrl+A) or reduced motion is asked
 *   for (8GENT_REDUCED_MOTION=1). Off means the final frame, drawn at once.
 *
 * Everything here is pure so the timing can be tested without a terminal.
 */

/** No burst may run longer than this. */
export const MOTION_BUDGET_MS = 300;

/** Tab underline sweep: frame interval and eased progress per frame. */
export const SWEEP_FRAME_MS = 50;
export const SWEEP_EASE: readonly number[] = [0.35, 0.7, 0.9, 1];

/** Turn settle: how long the still figure-8 holds before DONE. */
export const SETTLE_HOLD_MS = 120;

/** Trail rows that land together are staggered this far apart. */
export const STAGGER_MS = 80;

/** Reduced motion from the environment (checked once per call, cheap). */
export function reducedMotionFromEnv(env: Record<string, string | undefined> = process.env): boolean {
	const v = env["8GENT_REDUCED_MOTION"];
	return v === "1" || v === "true";
}

/** Whether motion should play: animations on and reduced motion not asked for. */
export function motionEnabled(animate: boolean, env?: Record<string, string | undefined>): boolean {
	return animate && !reducedMotionFromEnv(env);
}

export interface Span {
	x: number;
	width: number;
}

/**
 * The underline positions for a sweep from `from` to `to`, one per frame.
 * The last frame is always exactly `to`. Width eases with position, so the
 * bar resizes to the new label on the way.
 */
export function sweepFrames(from: Span, to: Span, ease: readonly number[] = SWEEP_EASE): Span[] {
	return ease.map((p) => ({
		x: Math.round(from.x + (to.x - from.x) * p),
		width: Math.max(1, Math.round(from.width + (to.width - from.width) * p)),
	}));
}

/**
 * The stagger for `count` rows landing together: STAGGER_MS apart, tightened
 * so the whole burst still ends within MOTION_BUDGET_MS. 0 means no stagger.
 */
export function staggerFor(count: number, stagger = STAGGER_MS): number {
	if (count <= 1) return 0;
	return Math.min(stagger, Math.floor(MOTION_BUDGET_MS / (count - 1)));
}
