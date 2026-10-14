import { afterAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	MAX_TEMPLATE_BYTES,
	defaultPromptsDir,
	expandPromptCommand,
	expandTemplate,
	loadPromptTemplates,
	parseTemplate,
	splitArgs,
} from "./prompts";

// Never touch the real ~/.8gent: HOME and EIGHT_HOME point at a temp home.
const savedHomeEnv = { HOME: process.env.HOME, EIGHT_HOME: process.env.EIGHT_HOME };
const testHome = mkdtempSync(join(tmpdir(), "prompts-home-"));
process.env.HOME = testHome;
process.env.EIGHT_HOME = testHome;
afterAll(() => {
	for (const [k, v] of Object.entries(savedHomeEnv)) {
		if (v === undefined) Reflect.deleteProperty(process.env, k);
		else process.env[k] = v;
	}
	rmSync(testHome, { recursive: true, force: true });
});

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

	test("a template over the size cap is skipped", () => {
		const dir = join(root, "big");
		mkdirSync(dir, { recursive: true });
		writeFileSync(join(dir, "huge.md"), "x".repeat(MAX_TEMPLATE_BYTES + 1));
		writeFileSync(join(dir, "ok.md"), "fine");
		expect(loadPromptTemplates([dir]).map((t) => t.name)).toEqual(["ok"]);
	});

	test("a case collision resolves by sorted name, not by disk order", () => {
		const dir = join(root, "case");
		mkdirSync(dir, { recursive: true });
		writeFileSync(join(dir, "Review.md"), "UPPER");
		writeFileSync(join(dir, "review.md"), "lower");
		const files = readdirSync(dir);
		const first = loadPromptTemplates([dir]);
		expect(first).toEqual(loadPromptTemplates([dir]));
		expect(first).toHaveLength(1);
		// Case-sensitive disk: two files, "Review.md" sorts first and wins.
		// Case-insensitive disk: one file holding the second write.
		expect(first[0].body).toBe(files.length === 2 ? "UPPER" : "lower");
	});

	test("arguments are inserted once, never expanded again", () => {
		expect(expandTemplate("Review $1. All: $ARGUMENTS", '"$ARGUMENTS" $(id) $& $1')).toBe(
			'Review $ARGUMENTS. All: "$ARGUMENTS" $(id) $& $1',
		);
	});

	test("the default folder comes from the OS home directory", () => {
		expect(defaultPromptsDir()).toBe(join(testHome, ".8gent", "prompts"));
	});
});
