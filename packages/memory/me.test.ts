import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
	addFact,
	buildMeContext,
	forgetFact,
	importMe,
	loadMe,
	meBlockForTurn,
	parseFact,
} from "./me.js";
import { estimateTokens } from "./types.js";

const fact = (name: string, desc: string, type: string, body: string) =>
	`---\nname: ${name}\ndescription: ${desc}\nmetadata:\n  type: ${type}\n---\n${body}\n`;

let dir: string;
beforeEach(() => {
	dir = fs.mkdtempSync(path.join(os.tmpdir(), "me-test-"));
	fs.writeFileSync(
		path.join(dir, "forge.md"),
		fact(
			"forge",
			"Forgejo is the source of truth",
			"reference",
			"Forgejo is truth. GitHub is a mirror.",
		),
	);
	fs.writeFileSync(
		path.join(dir, "style.md"),
		fact("style", "no em dashes", "feedback", "Never write em dashes in copy."),
	);
	fs.writeFileSync(
		path.join(dir, "garden.md"),
		fact("garden", "tomato plan", "user", "Plant tomatoes in May."),
	);
	fs.writeFileSync(path.join(dir, "notes.md"), "no frontmatter here\n");
	fs.writeFileSync(
		path.join(dir, "ME.md"),
		"- [forge](forge.md) - truth\n- [style](style.md) - dashes\n- [garden](garden.md) - tomatoes\n",
	);
});
afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

describe("loadMe", () => {
	test("loads facts sorted by name and the index verbatim; skips files without frontmatter", () => {
		const me = loadMe(dir);
		expect(me.facts.map((f) => f.name)).toEqual(["forge", "garden", "style"]);
		expect(me.facts[0].type).toBe("reference");
		expect(me.index).toContain("- [forge](forge.md) - truth");
	});
	test("missing folder is an empty profile", () => {
		expect(loadMe(path.join(dir, "nope"))).toEqual({
			dir: path.join(dir, "nope"),
			index: "",
			facts: [],
		});
	});
	test("rejects an unknown type", () => {
		expect(parseFact("x.md", fact("x", "d", "bogus", "b"))).toBeNull();
	});
});

describe("buildMeContext", () => {
	test("no query gives the index only", () => {
		const out = buildMeContext(loadMe(dir));
		expect(out).toBe(loadMe(dir).index.trim());
	});
	test("query adds matching bodies only, best score then name", () => {
		const out = buildMeContext(loadMe(dir), "which repo is the source of truth, forgejo or github");
		expect(out).toContain("### forge\nForgejo is truth.");
		expect(out).not.toContain("Plant tomatoes");
		const again = buildMeContext(
			loadMe(dir),
			"which repo is the source of truth, forgejo or github",
		);
		expect(again).toBe(out);
	});
	test("trims to maxTokens", () => {
		const out = buildMeContext(loadMe(dir), "forgejo tomatoes dashes", 20);
		expect(estimateTokens(out)).toBeLessThanOrEqual(20);
	});
});

describe("add and forget", () => {
	test("round trip touches only that fact", () => {
		const f = addFact(dir, "I prefer tabs over spaces");
		expect(f.type).toBe("user");
		expect(loadMe(dir).facts.map((x) => x.name)).toContain(f.name);
		expect(fs.readFileSync(path.join(dir, "ME.md"), "utf8")).toContain(`](${f.file})`);
		expect(forgetFact(dir, f.name)).toBe(true);
		expect(fs.existsSync(path.join(dir, f.file))).toBe(false);
		expect(fs.readFileSync(path.join(dir, "ME.md"), "utf8")).not.toContain(f.file);
		expect(fs.existsSync(path.join(dir, "forge.md"))).toBe(true);
		expect(fs.existsSync(path.join(dir, "notes.md"))).toBe(true);
		expect(forgetFact(dir, "does-not-exist")).toBe(false);
	});
	test("same text twice gets a distinct file", () => {
		const a = addFact(dir, "same words");
		const b = addFact(dir, "same words");
		expect(a.file).not.toBe(b.file);
	});
	test("forget never reaches outside the folder", () => {
		expect(forgetFact(dir, "../etc")).toBe(false);
	});
});

describe("importMe", () => {
	test("copies shaped files, renames MEMORY.md, skips existing", () => {
		const src = fs.mkdtempSync(path.join(os.tmpdir(), "me-src-"));
		const dest = fs.mkdtempSync(path.join(os.tmpdir(), "me-dest-"));
		try {
			fs.writeFileSync(path.join(src, "a.md"), fact("a", "d", "user", "A"));
			fs.writeFileSync(path.join(src, "b.md"), fact("b", "d", "project", "B"));
			fs.writeFileSync(path.join(src, "junk.md"), "plain\n");
			fs.writeFileSync(path.join(src, "MEMORY.md"), "- [a](a.md) - a\n");
			expect(importMe(src, dest)).toEqual({ imported: 2, skipped: 0, ignored: 1, index: "copied" });
			expect(fs.readFileSync(path.join(dest, "ME.md"), "utf8")).toContain("[a](a.md)");
			fs.writeFileSync(path.join(dest, "a.md"), fact("a", "d", "user", "EDITED"));
			expect(importMe(src, dest)).toEqual({ imported: 0, skipped: 2, ignored: 1, index: "kept" });
			expect(fs.readFileSync(path.join(dest, "a.md"), "utf8")).toContain("EDITED");
		} finally {
			fs.rmSync(src, { recursive: true, force: true });
			fs.rmSync(dest, { recursive: true, force: true });
		}
	});
});

describe("meBlockForTurn (the assembled block per turn)", () => {
	test("off by default", () => {
		expect(meBlockForTurn("forgejo", { EIGHT_ME_DIR: dir })).toBeNull();
	});
	test("on: ## ME block holds the matching fact body", () => {
		const b = meBlockForTurn("is forgejo the truth?", { EIGHT_ME: "1", EIGHT_ME_DIR: dir });
		expect(b?.startsWith("## ME\n")).toBe(true);
		expect(b).toContain("GitHub is a mirror.");
	});
});
