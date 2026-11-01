/**
 * Prompt templates typed as commands (#3918 G4): `/review src/app.ts` becomes
 * the text of ~/.8gent/prompts/review.md with its placeholders filled in
 * (packages/extensions/prompts.ts). Templates are read on each use, so a file
 * saved a moment ago is the one sent. A line that is not a template, or no
 * readable templates folder, passes through unchanged.
 */

import {
	type PromptTemplate,
	expandPromptCommand,
	loadPromptTemplates,
} from "../../../../packages/extensions/prompts.js";

export function expandPromptSlashCommand(
	message: string,
	templates: () => PromptTemplate[] = safeTemplates,
): string {
	if (!message.trimStart().startsWith("/")) return message;
	const expanded = expandPromptCommand(message.trim(), templates());
	return expanded ?? message;
}

function safeTemplates(): PromptTemplate[] {
	try {
		return loadPromptTemplates();
	} catch {
		return [];
	}
}
