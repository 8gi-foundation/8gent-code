/**
 * The opening line of a session. One fixed line of interface text, the same
 * every launch: the hint the app already gives for its input. Nothing here is
 * chosen at random and nothing claims anything about the person or the model.
 */
import type { Message } from "../app.js";

export const WELCOME_HINT = "/help for commands, Tab for suggestions, or just ask.";

export function makeWelcomeMessage(): Message {
	return {
		id: "welcome",
		role: "system",
		content: WELCOME_HINT,
		timestamp: new Date(),
	};
}
