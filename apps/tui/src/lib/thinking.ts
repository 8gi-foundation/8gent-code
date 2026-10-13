/**
 * The thinking level a person asks for in the TUI (#3918 D4, D10), kept
 * apart from what the provider can honour. /thinking and the cycle key set
 * the request; `describeThinking` says what the active provider will do with
 * it, through the same clamp the router uses (packages/providers/thinking-level.ts).
 */

import {
	type ThinkingLevel,
	resolveThinkingLevel,
} from "../../../../packages/providers/thinking-level.js";

/** What a person can ask for: off, or one of the router's levels. */
export type ThinkingChoice = "off" | ThinkingLevel;

/** The cycle key's order. "minimal" is accepted by name but skipped by the key. */
export const THINKING_CYCLE: readonly ThinkingChoice[] = ["off", "low", "medium", "high"];

const CHOICES: ReadonlySet<string> = new Set(["off", "minimal", "low", "medium", "high"]);

/** "/thinking HIGH" -> "high"; anything else -> null. */
export function parseThinkingChoice(arg: string | undefined): ThinkingChoice | null {
	const v = (arg ?? "").trim().toLowerCase();
	return CHOICES.has(v) ? (v as ThinkingChoice) : null;
}

/** The next choice after `current` in THINKING_CYCLE; "minimal" cycles to "low". */
export function nextThinkingChoice(current: ThinkingChoice): ThinkingChoice {
	const i = THINKING_CYCLE.indexOf(current);
	if (i === -1) return "low";
	return THINKING_CYCLE[(i + 1) % THINKING_CYCLE.length] ?? "off";
}

/**
 * What the provider will run with: the requested level clamped to its
 * supported set, or null when it runs without thinking.
 */
export function effectiveThinking(
	requested: ThinkingChoice,
	supported: readonly ThinkingLevel[],
): ThinkingLevel | null {
	if (requested === "off") return null;
	return resolveThinkingLevel(requested, supported);
}

/** One line for the chat: the request, and what the provider does with it. */
export function describeThinking(
	requested: ThinkingChoice,
	provider: string,
	supported: readonly ThinkingLevel[],
): string {
	if (requested === "off") return "Thinking: off.";
	const effective = effectiveThinking(requested, supported);
	if (effective === null) {
		return `Thinking: ${requested} requested. ${provider} supports no thinking levels, so turns run without it until you switch provider.`;
	}
	if (effective !== requested) {
		return `Thinking: ${requested} requested, clamped to ${effective} (the most ${provider} supports).`;
	}
	return `Thinking: ${requested}.`;
}

export const THINKING_USAGE = "/thinking off|low|medium|high, or /thinking show|hide";

/**
 * The chat bubbles that are the model's thinking: the prose it wrote while
 * choosing tools (app.tsx appends them as system-step0-* on the native tool
 * path; the text-tool path's onStepFinish carries no text, so local models
 * surface none yet). Ctrl+V and /thinking hide|show filter them (D10).
 */
export function isThinkingMessage(m: { id: string }): boolean {
	return m.id.startsWith("system-step0-");
}

export function visibleMessages<T extends { id: string }>(
	messages: readonly T[],
	showThinking: boolean,
): T[] {
	if (showThinking) return [...messages];
	return messages.filter((m) => !isThinkingMessage(m));
}
