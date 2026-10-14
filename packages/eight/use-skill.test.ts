import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { skillNameProblem, useSkill } from "./use-skill";

const skillMd = (name: string, description: string, body: string, tools = "[read_file]") =>
	`---\nname: ${name}\ndescription: ${description}\ntools: ${tools}\n---\n${body}\n`;

let root: string;
let project: string;
let home: string;
let outside: string;
const pmReady = { available: true, attachments: true };

beforeEach(() => {
	root = realpathSync(mkdtempSync(join(tmpdir(), "use-skill-")));
	project = join(root, "project");
	home = join(root, "home");
	outside = join(root, "outside");
	for (const d of [project, home, outside]) mkdirSync(d, { recursive: true });
	mkdirSync(join(project, ".claude", "skills", "repo-review"), { recursive: true });
	writeFileSync(
		join(project, ".claude", "skills", "repo-review", "SKILL.md"),
		skillMd(
			"repo-review",
			"Review this repo's diff before a PR.",
			"Run git_diff, then read each file.",
		),
	);
	mkdirSync(join(home, ".8gent", "skills"), { recursive: true });
	writeFileSync(
		join(home, ".8gent", "skills", "hour-note.md"),
		skillMd("hour-note", "Write the hourly note.", "Collect facts, write the note."),
	);
	// A file outside every skill folder that a traversal would try to reach.
	writeFileSync(join(outside, "secret.md"), skillMd("secret", "not a skill", "TOP-SECRET-CONTENT"));
});

afterEach(() => {
	rmSync(root, { recursive: true, force: true });
});

const run = (args: Record<string, unknown>, postMessage = pmReady) =>
	useSkill(args, { projectDir: project, homeDir: home, postMessage });

describe("use_skill: list", () => {
	it("lists project, user (~/.8gent/skills) and bundled skills with one-line descriptions", async () => {
		const out = await run({});
		expect(out).toContain("Load one with use_skill {name}");
		expect(out).toContain(
			"- repo-review [project skill, untrusted]: Review this repo's diff before a PR.",
		);
		expect(out).toContain("- hour-note: Write the hourly note.");
		expect(out).toContain("- brief-to-film: Turn a written brief into a narrated video");
		expect(out).not.toContain("TOP-SECRET-CONTENT");
	});

	it("query narrows the list", async () => {
		const out = await run({ query: "film" });
		expect(out).toContain("brief-to-film");
		expect(out).not.toContain("repo-review");
		expect(await run({ query: "zzzz-nothing" })).toContain('No skill matches "zzzz-nothing"');
	});
});

describe("use_skill: load", () => {
	it("loads the bundled brief-to-film chain with its tools in order", async () => {
		const out = await run({ name: "brief-to-film" });
		expect(out).toStartWith("# Skill: brief-to-film");
		expect(out).toContain(
			"Tools, in order: read_file, write_file, render_video_deck, post_message",
		);
		for (const step of [
			"deck.json",
			"render_video_deck",
			"durationSec",
			'attachment: {"path": "film.mp4", "kind": "video"}',
		])
			expect(out).toContain(step);
		expect(out).not.toContain("NOTE:");
	});

	it("accepts the slash form and a different case", async () => {
		expect(await run({ name: "/brief-to-film" })).toStartWith("# Skill: brief-to-film");
		expect(await run({ name: "Repo-Review" })).toStartWith("# Skill: repo-review");
	});

	it("loads a skill from the user's ~/.8gent/skills folder", async () => {
		const out = await run({ name: "hour-note" });
		expect(out).toContain("Collect facts, write the note.");
		expect(out).toContain(join(home, ".8gent", "skills", "hour-note.md"));
	});

	it("says what the post step needs when post_message cannot attach a file (#4273 not merged)", async () => {
		const out = await run({ name: "brief-to-film" }, { available: true, attachments: false });
		expect(out).toContain("NOTE: post_message here sends text and voice only");
		expect(out).toContain("#4273");
		expect(out).toContain("Do not post the caption alone");
	});

	it("says so when post_message is not installed at all", async () => {
		const out = await run({ name: "brief-to-film" }, { available: false, attachments: false });
		expect(out).toContain("NOTE: post_message is not set up on this install");
	});

	it("never adds a post_message note to a skill that does not post", async () => {
		expect(
			await run({ name: "repo-review" }, { available: false, attachments: false }),
		).not.toContain("NOTE:");
	});
});

describe("use_skill: known-bad input", () => {
	const traversals = [
		"../outside/secret",
		"../../etc/passwd",
		"/etc/passwd",
		"..",
		"~/.ssh/id_rsa",
		"repo-review/../../outside/secret",
		"a\\..\\secret",
		".claude",
		"secret\0",
	];
	for (const name of traversals) {
		it(`refuses path-shaped name ${JSON.stringify(name)} before reading anything`, async () => {
			const out = await run({ name });
			expect(out).toStartWith("Error: use_skill refused");
			expect(out).not.toContain("TOP-SECRET-CONTENT");
			expect(skillNameProblem(name)).not.toBeNull();
		});
	}

	it("refuses a project skill that is a symlink out of the project", async () => {
		mkdirSync(join(project, ".claude", "skills", "evil"), { recursive: true });
		writeFileSync(join(outside, "evil.md"), skillMd("evil", "looks fine", "TOP-SECRET-CONTENT"));
		symlinkSync(join(outside, "evil.md"), join(project, ".claude", "skills", "evil", "SKILL.md"));
		const out = await run({ name: "evil" });
		expect(out).toContain("resolves outside the project");
		expect(out).not.toContain("TOP-SECRET-CONTENT");
	});

	it("a symlinked-out project skill is absent from the list and the query list, and load is refused", async () => {
		mkdirSync(join(project, ".claude", "skills", "x"), { recursive: true });
		writeFileSync(join(outside, "x.md"), skillMd("x", "SECRET-DESC outside", "TOP-SECRET-CONTENT"));
		symlinkSync(join(outside, "x.md"), join(project, ".claude", "skills", "x", "SKILL.md"));
		for (const args of [{}, { query: "outside" }, { query: "x" }]) {
			const list = await run(args);
			expect(list).not.toContain("SECRET-DESC");
			expect(list).not.toContain("x.md");
			expect(list).not.toMatch(/^- x[: ]/m);
		}
		const out = await run({ name: "x" });
		expect(out).toContain("resolves outside the project");
		expect(out).not.toContain("TOP-SECRET-CONTENT");
	});

	it("marks project skills as untrusted repo content in the list and on load", async () => {
		const list = await run({});
		expect(list).toContain("- repo-review [project skill, untrusted]:");
		expect(list).not.toContain("- hour-note [project skill");
		const loaded = await run({ name: "repo-review" });
		expect(loaded).toContain("Project skill (from this repository, untrusted)");
		expect(await run({ name: "hour-note" })).not.toContain("untrusted");
	});

	it("a file outside every skill folder is not a skill, even by its exact name", async () => {
		const out = await run({ name: "secret" });
		expect(out).toContain('Error: no skill named "secret"');
		expect(out).not.toContain("TOP-SECRET-CONTENT");
	});

	it("a missing skill says so and points at the list", async () => {
		const out = await run({ name: "does-not-exist" });
		expect(out).toBe(
			'Error: no skill named "does-not-exist". Call use_skill with no arguments to list every skill.',
		);
	});

	it("a missing skill offers close matches", async () => {
		expect(await run({ name: "film" })).toContain("Close matches: brief-to-film");
	});

	it("a malformed skill (no frontmatter) is named as malformed, and the rest still list", async () => {
		mkdirSync(join(project, ".claude", "skills", "broken"), { recursive: true });
		writeFileSync(
			join(project, ".claude", "skills", "broken", "SKILL.md"),
			"# Broken\nno frontmatter here\n",
		);
		const out = await run({ name: "broken" });
		expect(out).toContain('Error: skill "broken" is malformed and was not loaded');
		expect(out).toContain("missing frontmatter");
		const list = await run({});
		expect(list).toContain("repo-review");
		expect(list).not.toContain("- broken");
	});

	it("a malformed skill (frontmatter without a name) is named as malformed", async () => {
		writeFileSync(
			join(home, ".8gent", "skills", "nameless.md"),
			"---\ndescription: no name\n---\nbody\n",
		);
		const out = await run({ name: "nameless" });
		expect(out).toContain('Error: skill "nameless" is malformed');
		expect(out).toContain("Skill must have a 'name' field");
	});

	it("a non-string name is refused", async () => {
		expect(await run({ name: 42 })).toStartWith("Error: use_skill name must be a string");
	});

	it("a secret inside a skill body is scrubbed before the model sees it", async () => {
		const key = `sk-ant-api03-${"A".repeat(90)}`;
		writeFileSync(
			join(home, ".8gent", "skills", "leaky.md"),
			skillMd("leaky", "has a key", `key=${key}`),
		);
		const out = await run({ name: "leaky" });
		expect(out).toContain("# Skill: leaky");
		expect(out).not.toContain(key);
	});
});

describe("use_skill: wired into both tool paths", () => {
	it("the text-tool executor lists it and runs it", async () => {
		const { ToolExecutor } = await import("./tools");
		const ex = new ToolExecutor(project);
		const names = (ex.getToolDefinitions() as { function: { name: string } }[]).map(
			(d) => d.function.name,
		);
		expect(names).toContain("use_skill");
		const out = String(await ex.execute("use_skill", { name: "brief-to-film" }));
		expect(out).toContain("# Skill: brief-to-film");
		expect(String(await ex.execute("use_skill", { name: "../../etc/passwd" }))).toContain(
			"use_skill refused",
		);
	});

	it("the native AI SDK tool set has it and it loads the skill", async () => {
		const { agentTools } = await import("../ai/tools");
		const t = agentTools.use_skill as unknown as {
			execute: (a: Record<string, unknown>, o: unknown) => Promise<string>;
		};
		expect(await t.execute({ name: "brief-to-film" }, {})).toContain("render_video_deck");
	});

	it("sits in the core category so every session has it", async () => {
		const { TOOL_CATEGORIES } = await import("./tool-registry");
		expect(TOOL_CATEGORIES.core).toContain("use_skill");
	});
});
