import { describe, expect, test } from "bun:test";
import type { PromptTemplate } from "../../../../packages/extensions/prompts.js";
import { expandPromptSlashCommand } from "./prompt-slash.js";
import { buildPromptEntries, mergeSlashEntries } from "./slash-registry.js";

const REVIEW: PromptTemplate = {
	name: "review",
	description: "Review a file for bugs",
	body: "Review $1 for correctness bugs. Mode: $2.",
	file: "/home/x/.8gent/prompts/review.md",
};

describe("prompt templates as /name (#3918 G4)", () => {
	test("a template command expands to its body with the arguments filled in", () => {
		expect(expandPromptSlashCommand("/review src/app.ts strict", () => [REVIEW])).toBe(
			"Review src/app.ts for correctness bugs. Mode: strict.",
		);
	});

	test("a line that is not a template passes through unchanged", () => {
		expect(expandPromptSlashCommand("/nope x", () => [REVIEW])).toBe("/nope x");
		expect(expandPromptSlashCommand("plain text", () => [REVIEW])).toBe("plain text");
		expect(expandPromptSlashCommand("/review a", () => [])).toBe("/review a");
	});

	test("a template is a menu entry with its description and file", () => {
		const [entry] = buildPromptEntries([REVIEW]);
		expect(entry).toMatchObject({
			token: "/review",
			name: "review",
			kind: "prompt",
			description: "Review a file for bugs",
			templateFile: REVIEW.file,
		});
		expect(buildPromptEntries([{ ...REVIEW, description: "" }])[0]?.description).toBe(
			"Prompt template",
		);
	});

	test("a built-in or a skill of the same name wins over a template", () => {
		const builtin = {
			token: "/help",
			name: "help",
			canonicalName: "help",
			description: "Show available commands",
			kind: "builtin" as const,
			builtInName: "help" as const,
		};
		const skill = {
			token: "/review",
			name: "review",
			canonicalName: "review",
			description: "A skill",
			kind: "skill" as const,
			skillName: "review",
		};
		const help: PromptTemplate = { ...REVIEW, name: "help", file: "/x/help.md" };
		const registry = mergeSlashEntries([builtin], [skill], buildPromptEntries([REVIEW, help]));
		expect(registry.byToken.get("/help")?.kind).toBe("builtin");
		expect(registry.byToken.get("/review")?.kind).toBe("skill");
		const only = mergeSlashEntries([builtin], [], buildPromptEntries([REVIEW]));
		expect(only.byToken.get("/review")?.kind).toBe("prompt");
	});
});
