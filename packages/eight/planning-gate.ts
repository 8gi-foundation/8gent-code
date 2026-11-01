/**
 * When the planning gate (packages/eight/agent.ts) fires (#4248).
 *
 * The gate adds a last user message that asks for a numbered plan and for
 * update_plan reports after every step. It used to fire on any prompt over
 * 100 characters. A single-goal prompt with a few format constraints is over
 * that (pilot msg-post-caption: 290 characters, no build verb), and on the
 * local 27B model the two update_plan rounds it asked for took 461 of the
 * turn's 606 s (317 s and 144 s of generation), while the same context
 * without a plan write took 8 s. The length trigger now needs a prompt long
 * enough to carry several goals; a build verb still fires the gate at any
 * length.
 */

/** Verbs that mark a prompt as a multi-step build. */
export const PLANNING_KEYWORDS =
	/\b(build|create|implement|fix|refactor|add|setup|configure|migrate|convert|redesign|scaffold|deploy|integrate)\b/i;

/** A prompt shorter than this with no build verb is one goal: no plan, no plan reports. */
export const PLANNING_GATE_MIN_CHARS = 400;

export function needsPlanningGate(text: string): boolean {
	return text.length > PLANNING_GATE_MIN_CHARS || PLANNING_KEYWORDS.test(text);
}
