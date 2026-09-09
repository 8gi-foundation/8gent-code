/**
 * Who owns the text the user just typed: onboarding, or the agent?
 *
 * Onboarding used to be a modal flag. Once `showOnboarding` was true every
 * non-slash submission was fed to `processAnswer`, so a user who typed a real
 * question got their question swallowed and an onboarding reply back:
 *
 *   You:   In one short sentence, what can you help me with here?
 *   8gent: Got it, your name is saved, James. What are you working on?
 *
 * The rule below decides by what is actually on screen rather than by a flag.
 * Onboarding may consume input only while its own question is the thing the
 * user is looking at and it is waiting for an answer to that question. Anything
 * else - including any input typed while onboarding is merely pending, and any
 * slash command - goes to the normal path, and onboarding simply waits.
 */
export interface OnboardingInputContext {
	/** The onboarding flow has been started and has not finished. */
	showOnboarding: boolean;
	/** Which screen the user is looking at. */
	viewMode: string;
	/** Text of the onboarding question currently rendered, if any. */
	currentQuestion: string | null;
	/** Raw text the user submitted. */
	input: string;
}

/**
 * Render an onboarding question for the message list, including what to type
 * when the step offers a fixed set of answers.
 *
 * The choice list has to live in the message text because OnboardingScreen is
 * not mounted: `renderMainContent` is voided in app.tsx, so the chat message
 * list is the only surface a question reaches. Without these hints a step like
 * "What best describes you?" gives the user nothing to type.
 */
export function formatOnboardingQuestion(q: {
	question: string;
	choices?: Array<{ label: string; value: string; description?: string }>;
}): string {
	if (!q.choices || q.choices.length === 0) return q.question;
	const lines = q.choices.map((c) => `  ${c.value}  ${c.label}`);
	return `${q.question}\n\n${lines.join("\n")}`;
}

export function shouldOnboardingConsumeInput(ctx: OnboardingInputContext): boolean {
	// A slash command is always a command. /skip and /skip all are handled by
	// the command layer, which knows about onboarding.
	if (ctx.input.trim().startsWith("/")) return false;

	// The flow must be running, its screen must be the one on display, and it
	// must have a question up. Any of those missing and the input is a prompt.
	if (!ctx.showOnboarding) return false;
	if (ctx.viewMode !== "onboarding") return false;
	if (!ctx.currentQuestion || ctx.currentQuestion.trim() === "") return false;

	return true;
}
