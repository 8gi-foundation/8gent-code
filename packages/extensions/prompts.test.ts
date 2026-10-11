import { afterAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	expandPromptCommand,
	expandTemplate,
	loadPromptTemplates,
	parseTemplate,
	splitArgs,
} from "./prompts";

const root = mkdtempSync(join(tmpdir(), "prompts-"));
afterAll(() => rmSync(root, { recursive: true, force: true }));

describe("prompt templates", () => {
	test("each .md file is a /name command with its description", () => {
		const user = join(root, "user");
		const project = join(root, "project");
		mkdirSync(user, { recursive: true });
		mkdirSync(project, { recursive: true });
		writeFileSync(
			join(user, "review.md"),
			"---\ndescription: Review a file\n---\nReview $1 ($2).\n",
		);
		writeFileSync(join(user, "plain.md"), "Explain this:");
		writeFileSync(join(user, "Bad Name.md"), "skipped");
		writeFileSync(join(user, "notes.txt"), "skipped");
		writeFileSync(join(project, "plain.md"), "Project wins:");
		const t = loadPromptTemplates([user, project, join(root, "absent")]);
		expect(t.map((x) => [x.name, x.description, x.body])).toEqual([
			["plain", "", "Project wins:"],
			["review", "Review a file", "Review $1 ($2)."],
		]);
		expect(expandPromptCommand('/review "src/a b.ts" strict', t)).toBe(
			"Review src/a b.ts (strict).",
		);
		expect(expandPromptCommand("/plain the diff", t)).toBe("Project wins:\n\nthe diff");
		expect(expandPromptCommand("/unknown x", t)).toBeNull();
		expect(expandPromptCommand("not a command", t)).toBeNull();
	});

	test("placeholders", () => {
		expect(expandTemplate("A $1 B $3 C $@ D $ARGUMENTS", "x y")).toBe("A x B  C x y D x y");
		expect(expandTemplate("no args here", "")).toBe("no args here");
		expect(splitArgs(`a "b c" 'd e' f`)).toEqual(["a", "b c", "d e", "f"]);
	});

	test("front matter with CRLF and quotes", () => {
		expect(parseTemplate('---\r\ndescription: "Fix it"\r\n---\r\nBody\r\n')).toEqual({
			description: "Fix it",
			body: "Body",
		});
		expect(parseTemplate("Just a body")).toEqual({ description: "", body: "Just a body" });
	});
});
