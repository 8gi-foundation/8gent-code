/**
 * Fix round 3 on #5241: a Duet diff may only stage regular files.
 * Layer 1, classifyAction: every git header mode is parsed as octal (git's own
 * strtoul(..., 8)), so 0120000 is a symlink too; gitlinks and binaries refused.
 * Layer 2, the apply command: after `git apply --index`, git's own parser
 * (`diff --cached --raw --no-renames`) must show only 100644/100755, or the
 * worktree is removed before the gate runs. Renames and copies of a symlink
 * carry no mode line at all, so only layer 2 can see them.
 */
import { describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";
import { classifyAction } from "../permissions/action-tiers.js";
import { shellRunner } from "./apply.js";
import { buildApplyCommand } from "./packet.js";
import { gateCommand } from "./pass.js";
import { fixture, sh } from "./testkit.js";

const tier = (payload: string) =>
	classifyAction({ kind: "apply_diff_worktree", target: "/r", payload });

/** A repo whose CLAUDE.md is a committed symlink to AGENTS.md, and whose gate leaves a marker. */
function linkFixture() {
	const f = fixture();
	fs.writeFileSync(path.join(f.ws, "AGENTS.md"), "hi\n");
	fs.symlinkSync("AGENTS.md", path.join(f.ws, "CLAUDE.md"));
	fs.writeFileSync(path.join(f.ws, "keep.md"), "keep\n");
	sh(f.ws, "git add AGENTS.md CLAUDE.md keep.md && git commit -q -m links");
	const marker = path.join(f.root, "gate-ran");
	f.setGate(`touch ${marker}`);
	const base = sh(f.ws, "git rev-parse HEAD").trim();
	/** Run `edit` in the workspace, capture the staged diff, then put the workspace back. */
	const diffAfter = (edit: string, flags = "") => {
		sh(f.ws, edit);
		const d = sh(f.ws, `git diff --cached ${flags}`);
		sh(f.ws, "git reset -q --hard && git clean -qfd");
		return d;
	};
	const apply = (id: string, diff: string) => {
		const cmd = buildApplyCommand(f.ws, f.dir, id, gateCommand(f.io, base), base);
		return shellRunner(cmd, 120_000, diff);
	};
	return { ...f, marker, diffAfter, apply };
}

function retarget(f: ReturnType<typeof linkFixture>) {
	return f.diffAfter("ln -sf /etc/passwd CLAUDE.md && git add CLAUDE.md");
}
function renamed(f: ReturnType<typeof linkFixture>) {
	return f.diffAfter("mkdir -p docs && git mv CLAUDE.md docs/x.md", "-M");
}
function copied(f: ReturnType<typeof linkFixture>) {
	return f.diffAfter(
		"mkdir -p docs && cp -P CLAUDE.md docs/y.md && git add docs/y.md",
		"-C --find-copies-harder",
	);
}
function gitlink(f: ReturnType<typeof linkFixture>) {
	return f.diffAfter("git update-index --add --cacheinfo 160000,$(git rev-parse HEAD),vendor/sub");
}

describe("layer 1: classifyAction refuses every non-regular mode", () => {
	test("a CLAUDE.md retarget to /etc/passwd (index ... 120000) is blocked", () => {
		const d = retarget(linkFixture());
		expect(d).toMatch(/^index [0-9a-f]+\.\.[0-9a-f]+ 120000$/m);
		expect(tier(d)).toMatchObject({ tier: "blocked" });
		expect(tier(d).reason).toContain("120000");
	});

	test("a bare index 120000 line is blocked", () => {
		const d =
			"diff --git a/docs/a.md b/docs/a.md\nindex 1111111..2222222 120000\n--- a/docs/a.md\n+++ b/docs/a.md\n@@ -1 +1 @@\n-a\n+/etc/passwd\n";
		expect(tier(d).tier).toBe("blocked");
	});

	for (const mode of [
		"120000",
		"0120000",
		"00000120000",
		"160000",
		" 0120000",
		"+120000",
		"12x000",
	]) {
		test(`new file mode ${JSON.stringify(mode)} is blocked (git parses modes as octal)`, () => {
			const d = `diff --git a/src/leak.ts b/src/leak.ts\nnew file mode ${mode}\n--- /dev/null\n+++ b/src/leak.ts\n@@ -0,0 +1 @@\n+/etc/passwd\n`;
			expect(tier(d).tier).toBe("blocked");
		});
	}

	for (const header of [
		"old mode 0120000\nnew mode 100644",
		"old mode 100644\nnew mode 00000120000",
	]) {
		test(`a mode change ${JSON.stringify(header)} is blocked`, () => {
			const d = `diff --git a/src/a.ts b/src/a.ts\n${header}\n`;
			expect(tier(d).tier).toBe("blocked");
		});
	}

	test("deleted file mode 0120000 is blocked", () => {
		const d =
			"diff --git a/src/a.ts b/src/a.ts\ndeleted file mode 0120000\nindex 1111111..0000000\n--- a/src/a.ts\n+++ /dev/null\n@@ -1 +0,0 @@\n-x\n";
		expect(tier(d).tier).toBe("blocked");
	});

	test("a gitlink add (new file mode 160000, Subproject commit) is blocked", () => {
		const d = gitlink(linkFixture());
		expect(d).toContain("new file mode 160000");
		expect(tier(d).tier).toBe("blocked");
		expect(tier(d.replace("new file mode 160000\n", "")).reason).toContain("submodule");
	});

	test("a binary patch is blocked, in both forms git emits", () => {
		expect(
			tier(
				"diff --git a/src/a.ts b/src/a.ts\nindex 1111111..2222222 100644\nBinary files a/src/a.ts and b/src/a.ts differ\n",
			).tier,
		).toBe("blocked");
		expect(
			tier(
				"diff --git a/src/a.ts b/src/a.ts\nindex 1111111..2222222 100644\nGIT binary patch\nliteral 1\n",
			).tier,
		).toBe("blocked");
	});

	test("regular modes still pass: 100644, 100755, 0100644 and an index line without a mode", () => {
		const ok = (h: string) =>
			`diff --git a/src/a.ts b/src/a.ts\n${h}\n--- a/src/a.ts\n+++ b/src/a.ts\n@@ -1 +1 @@\n-a\n+b\n`;
		expect(tier(ok("index 1111111..2222222 100644")).tier).toBe("gated");
		expect(tier(ok("index 1111111..2222222 100755")).tier).toBe("gated");
		expect(tier(ok("old mode 100644\nnew mode 0100755\nindex 1111111..2222222")).tier).toBe(
			"gated",
		);
	});

	test("jest, playwright, prettier and turbo configs are refused like the rest", () => {
		for (const name of [
			"jest.config.ts",
			"playwright.config.ts",
			"prettier.config.mjs",
			"turbo.json",
		]) {
			const d = `diff --git a/${name} b/${name}\nnew file mode 100644\n--- /dev/null\n+++ b/${name}\n@@ -0,0 +1 @@\n+x\n`;
			expect(tier(d).reason).toContain("tool config");
		}
	});
});

describe("layer 2: the apply command refuses a staged non-regular entry before the gate", () => {
	const cases: [string, (f: ReturnType<typeof linkFixture>) => string][] = [
		["a CLAUDE.md retarget to /etc/passwd", retarget],
		["a symlink renamed onto docs/x.md", renamed],
		["a symlink copied onto docs/y.md", copied],
		["a gitlink add", gitlink],
	];
	for (const [label, make] of cases) {
		test(`${label}: refused, worktree and branch removed, gate never runs`, () => {
			const f = linkFixture();
			const id = `mode${label.length}`;
			const r = f.apply(id, make(f));
			expect(r.code).not.toBe(0);
			expect(r.output).toContain("refused: the patch staged");
			expect(fs.existsSync(f.marker)).toBe(false);
			expect(fs.existsSync(path.join(f.dir, "worktrees", id))).toBe(false);
			expect(sh(f.ws, `git branch --list prepared/${id}`).trim()).toBe("");
		});
	}

	test("the rename and copy carry no mode line, so layer 1 alone lets them through", () => {
		const f = linkFixture();
		expect(tier(renamed(f)).tier).toBe("gated");
		expect(tier(copied(f)).tier).toBe("gated");
	});

	test("control: a regular edit, add and delete pass the check and the gate runs", () => {
		const f = linkFixture();
		const d = f.diffAfter(
			"printf 'new\\n' > keep.md && printf 'x\\n' > added.md && git rm -q AGENTS.md && git add keep.md added.md",
		);
		const r = f.apply("modectl", d);
		expect(r.output).not.toContain("refused");
		expect(r.code).toBe(0);
		expect(fs.existsSync(f.marker)).toBe(true);
	});
});
