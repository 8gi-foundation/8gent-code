/**
 * #3809: System One must not block a plain mv inside the workspace.
 *
 * The pilot case (env-setup-practice, 10 Oct 2026): `mv inbox/note-1.txt
 * inbox/notes/` was blocked by the judge (pYes 0.49 to 0.70) while the same
 * shape with doc-1.md passed. The judge here is a stub that answers
 * "dangerous" to everything, so a command that reaches it is blocked. A
 * command the new lane passes never reaches it; every negative must still
 * reach it.
 */

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { cleanupTempDirs, tempDir } from "../../tests/temp-dirs";
import { createDecider } from "../decide/index";
import type { DecideBackend, SystemOneRequest, SystemOneResponse } from "../decide/types";
import { _setPasswdHomeForTests } from "./s1-account-home";
import { singleFileDelete } from "./s1-rm-single";
import {
	generatedDataName,
	hasDotSegment,
	moveInProject,
	protectedRel,
	relSegments,
	windowsAliasOperand,
} from "./s1-mv-in-project";
import {
	SYSTEM_ONE_ALLOWLIST_FLAG,
	SYSTEM_ONE_BLOCK_MARKER,
	SYSTEM_ONE_FLAG,
	_resetSystemOne,
	_setSystemOneOverridesForTests,
	systemOneGate,
} from "./system-one-gate";

afterAll(cleanupTempDirs);

class AlwaysDangerous implements DecideBackend {
	readonly name = "stub";
	readonly model = "always-dangerous";
	asks = 0;
	async ask(request: SystemOneRequest): Promise<SystemOneResponse> {
		this.asks++;
		return {
			answers: [
				{
					id: request.questions[0].id,
					kind: "noul",
					probabilities: { yes: 0.99 },
					confidence: 0.99,
				},
			],
			backend: this.name,
			model: this.model,
			latencyMs: 0,
		};
	}
}

let ws: string;
let outside: string;
let judge: AlwaysDangerous;
const saved: Record<string, string | undefined> = {};
const KEYS = [SYSTEM_ONE_FLAG, SYSTEM_ONE_ALLOWLIST_FLAG, "EIGHT_HEADLESS", "EIGHT_WORKSPACE_ROOT"];

beforeAll(() => {
	for (const k of KEYS) saved[k] = process.env[k];
	Reflect.deleteProperty(process.env, "EIGHT_WORKSPACE_ROOT");
	Reflect.deleteProperty(process.env, SYSTEM_ONE_ALLOWLIST_FLAG);
	process.env.EIGHT_HEADLESS = "1";
});

afterAll(() => {
	for (const k of KEYS) {
		if (saved[k] === undefined) Reflect.deleteProperty(process.env, k);
		else process.env[k] = saved[k];
	}
	_resetSystemOne();
});

beforeEach(() => {
	ws = tempDir("s1-mv-ws-");
	outside = tempDir("s1-mv-out-");
	// The scenario fixture: loose files in inbox/ plus the folders the model makes.
	mkdirSync(join(ws, "inbox", "notes"), { recursive: true });
	mkdirSync(join(ws, "inbox", "docs"));
	for (const f of ["note-1.txt", "note-2.txt", "doc-1.md", "sheet-1.csv"])
		writeFileSync(join(ws, "inbox", f), "x");
	writeFileSync(join(ws, "inbox", "notes", "note-9.txt"), "existing");
	writeFileSync(join(ws, "package.json"), "{}");
	writeFileSync(join(ws, ".env"), "SECRET=1");
	writeFileSync(join(ws, "bun.lock"), "{}");
	writeFileSync(join(ws, "server.key"), "k");
	mkdirSync(join(ws, ".git"));
	mkdirSync(join(ws, ".claude"));
	mkdirSync(join(ws, "nested", ".git"), { recursive: true });
	mkdirSync(join(ws, "deep", "sub", ".git"), { recursive: true });
	// a submodule: its .git is a file pointing at the superproject's modules dir
	mkdirSync(join(ws, "sub-module"));
	writeFileSync(join(ws, "sub-module", ".git"), "gitdir: ../.git/modules/sub-module\n");
	writeFileSync(join(ws, "sub-module", "a.txt"), "x");
	mkdirSync(join(ws, "packages", "permissions"), { recursive: true });
	writeFileSync(join(ws, "packages", "permissions", "policy-engine.ts"), "x");
	mkdirSync(join(ws, "hooks"));
	writeFileSync(join(ws, "hooks", "pre-push"), "x");
	mkdirSync(join(ws, "withenv"));
	writeFileSync(join(ws, "withenv", ".env"), "S=1");
	mkdirSync(join(ws, "plain"));
	writeFileSync(join(ws, "plain", "a.txt"), "x");
	writeFileSync(join(ws, "plain", "note-1.txt"), "x");
	writeFileSync(join(outside, "victim.txt"), "x");
	symlinkSync(join(outside, "victim.txt"), join(ws, "inbox", "link.txt"));
	symlinkSync(outside, join(ws, "escape"));
	symlinkSync(join(ws, "inbox", "notes"), join(ws, "notes-link"));
	judge = new AlwaysDangerous();
	_setSystemOneOverridesForTests({
		createDecider: () => createDecider({ backend: judge, cacheSize: 0 }),
		askHuman: async () => null,
		calibrationDir: tempDir("s1-mv-nocal-"),
	});
	process.env[SYSTEM_ONE_FLAG] = "1";
});

afterEach(() => {
	rmSync(ws, { recursive: true, force: true });
	rmSync(outside, { recursive: true, force: true });
	Reflect.deleteProperty(process.env, SYSTEM_ONE_ALLOWLIST_FLAG);
});

describe("moveInProject allows", () => {
	for (const cmd of [
		"mv inbox/note-1.txt inbox/notes/",
		"mv inbox/note-1.txt inbox/notes",
		"mv inbox/doc-1.md inbox/docs/",
		"mv inbox/sheet-1.csv inbox/sheet-renamed.csv",
		"mv -n inbox/note-1.txt inbox/notes/",
		"mv -v inbox/note-1.txt inbox/notes/",
		"mv ./inbox/note-1.txt ./inbox/notes/",
		"mv inbox/note-1.txt inbox/note-2.txt inbox/notes/",
		"mv plain inbox/plain-moved",
		"git mv inbox/note-1.txt inbox/notes/",
		"git mv inbox/doc-1.md inbox/sheet-1.csv inbox/docs/",
		"git mv inbox/note-1.txt inbox/note-2.txt inbox/sheet-1.csv inbox/notes/",
		"git mv inbox/sheet-1.csv inbox/sheet-renamed.csv",
		"git mv -n -v inbox/note-1.txt inbox/notes/",
	]) {
		test(cmd, () => {
			expect(moveInProject(cmd, ws).ok).toBe(true);
		});
	}
});

describe("moveInProject: generated-data dotfiles and .tmp (#3943)", () => {
	beforeEach(() => {
		writeFileSync(join(ws, "e2e.json"), "[]");
		writeFileSync(join(ws, ".todo-e2e.json"), "[]");
		writeFileSync(join(ws, ".mcp.json"), "{}");
		writeFileSync(join(ws, ".eslintrc.json"), "{}");
		writeFileSync(join(ws, "tsconfig.json"), "{}");
		mkdirSync(join(ws, ".tmp"));
		mkdirSync(join(ws, ".other"));
	});

	test("the exact command from the issue: mv e2e.json .todo-e2e.json .tmp/", () => {
		expect(moveInProject("mv e2e.json .todo-e2e.json .tmp/", ws).ok).toBe(true);
	});

	for (const cmd of [
		"mv e2e.json .tmp",
		"mv -f e2e.json .tmp/",
		"mv -fv e2e.json .tmp/",
		"mv -nf e2e.json .tmp/",
		"mv .todo-e2e.json .tmp/",
		"mv .todo-e2e.json .tmp/result.json",
		"mv e2e.json .todo-moved.json",
		"mv inbox/note-1.txt .tmp/",
	]) {
		test(`allows: ${cmd}`, () => {
			expect(moveInProject(cmd, ws).ok).toBe(true);
		});
	}

	for (const cmd of [
		"mv .mcp.json .tmp/",
		"mv .eslintrc.json .tmp/",
		"mv .env .tmp/",
		"mv e2e.json .mcp.json",
		"mv e2e.json .tmp/.mcp.json",
		"mv e2e.json .other/",
		"mv e2e.json .git/",
		"mv e2e.json .git/hooks/",
		"mv e2e.json .claude/",
		"mv .tmp .other/",
		"mv .other .tmp/",
		"mv e2e.json tsconfig.json",
		"mv e2e.json packages/permissions/x.json",
		"mv e2e.json ../out.json",
		"mv e2e.json /tmp/",
		"mv e2e.json escape/",
		"mv e2e.json notes-link/",
		"mv inbox/link.txt .tmp/",
		"mv -t .tmp e2e.json",
		"mv --target-directory=.tmp e2e.json",
		"mv -f e2e.json .tmp/../x",
		"mv e2e.json *.json",
		"mv *.json .tmp/",
		"mv -f e2e.json .todo-e2e.json",
		"mv e2e.json .tmp/ && rm -rf .",
	]) {
		test(`still judged: ${cmd}`, () => {
			expect(moveInProject(cmd, ws).ok).toBe(false);
		});
	}

	test(".tmp as a symlink is refused", () => {
		rmSync(join(ws, ".tmp"), { recursive: true });
		symlinkSync(join(ws, "inbox"), join(ws, ".tmp"));
		expect(moveInProject("mv e2e.json .tmp/", ws).ok).toBe(false);
	});

	test("both pilot commands pass the gate without asking the judge", async () => {
		for (const cmd of ["mv e2e.json .todo-e2e.json .tmp/"]) {
			const g = await systemOneGate(cmd, process.env, ws);
			expect(g.run, cmd).toBe(true);
			expect(g.guard?.backend).toBe("allowlist");
		}
		expect(judge.asks).toBe(0);
	});
});

describe("moveInProject refuses", () => {
	const refused: Array<[string, string]> = [
		["a destination outside the workspace (absolute)", `mv inbox/note-1.txt ${"/tmp"}/x.txt`],
		["a destination outside with ..", "mv inbox/note-1.txt ../x.txt"],
		["a source outside with ..", "mv ../x.txt inbox/notes/"],
		["an absolute source", "mv /etc/hosts inbox/notes/"],
		["home as a destination", "mv inbox/note-1.txt ~/"],
		["a destination through a symlinked directory", "mv inbox/note-1.txt escape/"],
		["a symlink destination directory inside", "mv inbox/note-1.txt notes-link/"],
		["a symlink source", "mv inbox/link.txt inbox/notes/"],
		["an overwrite of an existing file", "mv inbox/note-1.txt inbox/note-2.txt"],
		["an overwrite inside a destination directory", "mv inbox/note-9.txt inbox/notes/"],
		["an overwrite of a protected file", "mv inbox/note-1.txt package.json"],
		["an overwrite of .env", "mv inbox/note-1.txt .env"],
		["moving a protected manifest", "mv package.json inbox/notes/"],
		["moving a lockfile", "mv bun.lock inbox/notes/"],
		["moving a key file", "mv server.key inbox/notes/"],
		["moving .env", "mv .env inbox/notes/"],
		["renaming to a protected name", "mv inbox/note-1.txt inbox/package.json"],
		["renaming to a dotfile", "mv inbox/note-1.txt inbox/.hidden"],
		["moving into .git", "mv inbox/note-1.txt .git/"],
		["moving into .claude", "mv inbox/note-1.txt .claude/"],
		["moving .git", "mv .git inbox/notes/"],
		["moving a nested repository", "mv nested inbox/notes/"],
		["git mv of a submodule directory", "git mv sub-module inbox/notes/"],
		["mv of a submodule directory", "mv sub-module inbox/notes/"],
		["git mv onto CLAUDE.md", "git mv inbox/note-1.txt CLAUDE.md"],
		["mv onto CLAUDE.md", "mv inbox/note-1.txt CLAUDE.md"],
		["mv onto lower-case agents.md", "mv inbox/note-1.txt agents.md"],
		["mv onto Gemini.md in a folder", "mv inbox/note-1.txt inbox/notes/Gemini.md"],
		["a variable target", "mv inbox/note-1.txt $HOME/"],
		["a variable source", "mv $F inbox/notes/"],
		["a glob in the destination", "mv inbox/note-1.txt inbox/no*/"],
		["a quoted path", 'mv "inbox/note-1.txt" inbox/notes/'],
		["a command substitution", "mv inbox/note-1.txt $(pwd)/x"],
		["a chained command", "mv inbox/note-1.txt inbox/notes/ && rm -rf inbox"],
		["force flag over an existing file", "mv -f inbox/note-1.txt inbox/notes/note-9.txt"],
		["target-directory flag", "mv -t inbox/notes inbox/note-1.txt"],
		["a missing source", "mv inbox/nope.txt inbox/notes/"],
		["a new directory by trailing slash", "mv inbox/note-1.txt inbox/fresh/"],
		["a rename with a missing parent", "mv inbox/note-1.txt missing/x.txt"],
		["several sources into a non-directory", "mv inbox/note-1.txt inbox/note-2.txt inbox/new.txt"],
		["a directory into itself", "mv inbox inbox/notes/inbox"],
		["one operand", "mv inbox/note-1.txt"],
		["cp -r of a directory", "cp -r plain inbox/plain-copy"],
		["a repository buried below a directory", "mv deep inbox/notes/"],
		["a directory holding a dotfile", "mv withenv inbox/notes/"],
		["a directory that contains protected paths", "mv packages inbox/notes/"],
		["security source", "mv packages/permissions/policy-engine.ts inbox/notes/"],
		["landing in security source", "mv inbox/note-1.txt packages/permissions/"],
		["a git hook directory", "mv hooks inbox/notes/hooks"],
		["landing as tsconfig", "mv inbox/note-1.txt tsconfig.json"],
		["landing as a jest config", "mv inbox/note-1.txt inbox/jest.config.js"],
		["landing as conftest", "mv inbox/note-1.txt conftest.py"],
		["landing as a shell script", "mv inbox/note-1.txt inbox/run.sh"],
		["landing as a git hook name", "mv inbox/note-1.txt pre-push"],
		["landing as credentials", "mv inbox/note-1.txt credentials"],
		["the workspace root", "mv . inbox/x"],
		["git mv outside destination", "git mv inbox/note-1.txt ../x.txt"],
		["git mv absolute destination", "git mv inbox/note-1.txt /tmp/x.txt"],
		["git mv traversal source", "git mv ../x.txt inbox/notes/"],
		["git mv traversal in the middle", "git mv inbox/note-1.txt inbox/../../x"],
		["git mv through a symlinked directory", "git mv inbox/note-1.txt escape/"],
		["git mv symlink source", "git mv inbox/link.txt inbox/notes/"],
		["git mv overwrite", "git mv inbox/note-1.txt inbox/note-2.txt"],
		["git mv overwrite in destination directory", "git mv inbox/note-9.txt inbox/notes/"],
		["git mv -f", "git mv -f inbox/note-1.txt inbox/note-2.txt"],
		["git mv -f without a clash", "git mv -f inbox/note-1.txt inbox/notes/"],
		["git mv --force", "git mv --force inbox/note-1.txt inbox/notes/"],
		["git mv -k", "git mv -k inbox/note-1.txt inbox/notes/"],
		["git -C before mv", "git -C .. mv inbox/note-1.txt inbox/notes/"],
		["git -c before mv", "git -c core.hooksPath=x mv inbox/note-1.txt inbox/notes/"],
		["git mv protected manifest", "git mv package.json inbox/notes/"],
		["git mv into .git", "git mv inbox/note-1.txt .git/x"],
		["git mv chained with ;", "git mv inbox/note-1.txt inbox/notes/ ; rm -rf inbox"],
		["git mv chained with &&", "git mv inbox/note-1.txt inbox/notes/ && echo hi"],
		["git mv piped", "git mv inbox/note-1.txt inbox/notes/ | cat"],
		["git mv one operand", "git mv inbox/note-1.txt"],
		["git mv several sources into a non-directory", "git mv inbox/note-1.txt inbox/note-2.txt inbox/new.txt"],
		["mv several sources, one escapes", "mv inbox/note-1.txt ../x.txt inbox/notes/"],
		["mv several sources, one overwrites", "mv inbox/note-1.txt inbox/note-9.txt inbox/notes/"],
		["mv several sources with the same base name", "mv inbox/note-1.txt plain/note-1.txt inbox/docs/"],
		["mv chained with ;", "mv inbox/note-1.txt inbox/notes/ ; ls"],
		["mv piped", "mv inbox/note-1.txt inbox/notes/ | cat"],
	];
	for (const [name, cmd] of refused) {
		test(name, () => {
			expect(moveInProject(cmd, ws).ok).toBe(false);
		});
	}

	test("no working directory", () => {
		expect(moveInProject("mv inbox/note-1.txt inbox/notes/", undefined).ok).toBe(false);
	});
});

// The helpers take the platform, so these run the Windows and macOS rules on any runner (#3814).
describe("moveInProject path rules on any OS", () => {
	test("win32 relative paths split on backslash and slash", () => {
		expect(relSegments("sub\\.claude", "win32")).toEqual(["sub", ".claude"]);
		expect(relSegments("sub/.claude", "win32")).toEqual(["sub", ".claude"]);
		expect(relSegments("sub\\x", "linux")).toEqual(["sub\\x"]);
	});

	test("a dot directory below a win32 path is seen", () => {
		expect(hasDotSegment("sub\\.claude", "win32")).toBe(true);
		expect(hasDotSegment("a\\b\\.git\\hooks", "win32")).toBe(true);
		expect(hasDotSegment("sub\\notes", "win32")).toBe(false);
	});

	test("protected prefixes match with backslashes on win32", () => {
		for (const rel of [
			"packages\\permissions",
			"packages\\permissions\\policy-engine.ts",
			"packages\\decide\\x",
			"hooks",
			"hooks\\pre-push",
			"packages",
		])
			expect(protectedRel(rel, "win32"), rel).toBe(true);
		expect(protectedRel("inbox\\notes", "win32")).toBe(false);
		expect(protectedRel("packages\\tools", "win32")).toBe(false);
	});

	test("protected prefixes are case-folded on win32 and darwin, not on linux", () => {
		for (const platform of ["win32", "darwin"] as const) {
			expect(protectedRel("Hooks", platform), platform).toBe(true);
			expect(protectedRel("HOOKS/x", platform), platform).toBe(true);
			expect(protectedRel("Packages/Permissions", platform), platform).toBe(true);
			expect(protectedRel("PACKAGES\\DECIDE", platform), platform).toBe(platform === "win32");
		}
		expect(protectedRel("Hooks", "linux")).toBe(false);
	});

	test("win32 alias operands are refused: stream, trailing dot, 8.3 short name", () => {
		for (const o of ["hooks.", "sub/hooks.", "a:b", "x.txt:stream", "PACKAGE~1/x", "PERMIS~1"])
			expect(windowsAliasOperand(o, "win32"), o).toBe(true);
		for (const o of ["inbox/notes", "inbox/note-1.txt", "a.b/c"])
			expect(windowsAliasOperand(o, "win32"), o).toBe(false);
		expect(windowsAliasOperand("hooks.", "linux")).toBe(false);
		expect(windowsAliasOperand("PACKAGE~1", "darwin")).toBe(false);
	});
});

/**
 * The glob lane expands `*` and `?` the way a POSIX shell would and has no
 * opinion anywhere else: on Windows expandGlobs() answers null, so a glob
 * always goes to the judge there. A written operand is the old lane on every OS.
 */
const GLOB_LANE = process.platform !== "win32";
const hasGlob = (cmd: string) => /[*?]/.test(cmd);

describe("globs and cp inside the workspace (#4073)", () => {
	beforeEach(() => {
		mkdirSync(join(ws, "inbox", "deeper", "x"), { recursive: true });
		writeFileSync(join(ws, "inbox", "deeper", "a-1.txt"), "x");
		writeFileSync(join(ws, "inbox", "deeper", "a-2.txt"), "x");
		writeFileSync(join(ws, "inbox", ".hidden.txt"), "x");
	});

	for (const cmd of [
		"mv inbox/note-*.txt inbox/notes/",
		"mv inbox/doc-*.md inbox/docs/",
		"mv inbox/sheet-*.csv inbox/sheets-new",
		"mv inbox/note-?.txt inbox/deeper/x/",
		"mv inbox/deeper/a-*.txt inbox/notes/",
		"mv -n inbox/doc-*.md inbox/docs/",
		"cp inbox/note-1.txt inbox/notes/copy-1.txt",
		"cp -n inbox/doc-1.md inbox/docs/",
		"cp inbox/note-*.txt inbox/deeper/x/",
		"cp inbox/deeper/a-1.txt inbox/deeper/x/b.txt",
	]) {
		test(`allows: ${cmd}`, () => {
			if (cmd.includes("sheets-new")) mkdirSync(join(ws, "inbox", "sheets-new"));
			expect(moveInProject(cmd, ws).ok).toBe(hasGlob(cmd) ? GLOB_LANE : true);
		});
	}

	for (const cmd of [
		"mv inbox/note-*.txt /tmp/",
		"mv inbox/note-*.txt ../",
		"mv inbox/note-*.txt ..",
		"mv inbox/note-*.txt ~/.8gent/",
		"mv inbox/note-*.txt /Users/x/.8gent/skills/",
		"mv ../*.txt inbox/notes/",
		"mv inbox/../../*.txt inbox/notes/",
		"mv /etc/pass* inbox/notes/",
		"mv inbox/*/*.txt inbox/notes/",
		"mv inbox/note-*.txt inbox/notes/ ; rm -rf inbox",
		"mv inbox/note-*.txt inbox/notes/ && rm -rf inbox",
		"mv inbox/note-*.txt $(pwd)/x/",
		"mv inbox/note-*.txt `pwd`/x/",
		"mv inbox/note-*.txt inbox/notes/ | cat",
		"mv inbox/nothing-*.txt inbox/notes/",
		"mv *.json inbox/notes/",
		"mv inbox/note-[12].txt inbox/notes/",
		"mv inbox/n{ote-1,ote-2}.txt inbox/notes/",
		"mv inbox/.hid* inbox/notes/",
		"mv inbox/note-*.txt inbox/doc-*.md inbox/notes/",
		"cp -r inbox inbox/notes/inbox",
		"cp -a inbox/note-1.txt inbox/notes/x.txt",
		"cp -f inbox/note-1.txt inbox/notes/note-9.txt",
		"cp inbox/note-1.txt inbox/notes/note-9.txt",
		"cp inbox/note-1.txt /tmp/x.txt",
		"cp inbox/note-1.txt ../x.txt",
		"cp inbox/note-1.txt ~/.8gent/x.txt",
		"cp -r ~/.ssh inbox/notes/",
		"cp ~/.ssh/id_rsa inbox/notes/",
		"cp /Users/x/.ssh/id_rsa inbox/notes/",
		"cp .env inbox/notes/e.txt",
		"cp inbox/note-1.txt inbox/notes/ && rm -rf inbox",
		"cp inbox/note-1.txt inbox/notes/x.txt; cat /etc/passwd",
		"cp inbox/note-*.txt $(pwd)/x/",
		"cp -t inbox/notes inbox/note-1.txt",
		"cp packages/permissions/policy-engine.ts inbox/notes/p.txt",
	]) {
		test(`still judged: ${cmd}`, () => {
			expect(moveInProject(cmd, ws).ok).toBe(false);
		});
	}

	test("a glob that matches a symlink is refused", () => {
		symlinkSync(outside, join(ws, "inbox", "link-out"));
		expect(moveInProject("mv inbox/link-* inbox/notes/", ws).ok).toBe(false);
		expect(moveInProject("cp inbox/link-* inbox/notes/", ws).ok).toBe(false);
	});

	test("a glob that matches a file linking out is refused, the rest not moved either", () => {
		writeFileSync(join(outside, "secret.txt"), "s");
		symlinkSync(join(outside, "secret.txt"), join(ws, "inbox", "note-evil.txt"));
		expect(moveInProject("mv inbox/note-*.txt inbox/notes/", ws).ok).toBe(false);
		expect(moveInProject("cp inbox/note-*.txt inbox/deeper/x/", ws).ok).toBe(false);
	});

	test("a symlinked directory in the source path is refused", () => {
		symlinkSync(outside, join(ws, "escape-dir"));
		writeFileSync(join(outside, "o-1.txt"), "x");
		expect(moveInProject("mv escape-dir/o-*.txt inbox/notes/", ws).ok).toBe(false);
		expect(moveInProject("cp escape-dir/o-*.txt inbox/notes/", ws).ok).toBe(false);
	});

	test("a glob landing on an existing name is refused (nothing overwritten)", () => {
		writeFileSync(join(ws, "inbox", "notes", "note-1.txt"), "old");
		expect(moveInProject("mv inbox/note-*.txt inbox/notes/", ws).ok).toBe(false);
	});

	test("a file named like a flag is never expanded", () => {
		writeFileSync(join(ws, "-n"), "x");
		writeFileSync(join(ws, "-rf"), "x");
		expect(moveInProject("mv * inbox/notes/", ws).ok).toBe(false);
	});

	test("the judge is never asked for the pilot commands, and still decides the risky ones", async () => {
		// With no glob lane (win32) the glob reaches the judge, who says dangerous: one ask.
		const ok = await systemOneGate("mv inbox/note-*.txt inbox/notes/", process.env, ws);
		expect(ok.run).toBe(GLOB_LANE);
		expect(judge.asks).toBe(GLOB_LANE ? 0 : 1);
		const cp = await systemOneGate("cp inbox/note-1.txt inbox/notes/c.txt", process.env, ws);
		expect(cp.run).toBe(true);
		expect(judge.asks).toBe(GLOB_LANE ? 0 : 1);
		for (const cmd of [
			"mv inbox/note-*.txt /tmp/",
			"mv inbox/note-*.txt ~/.8gent/",
			"cp -r ~/.ssh inbox/notes/",
			"mv inbox/note-*.txt inbox/notes/ && rm -rf inbox",
		]) {
			const r = await systemOneGate(cmd, process.env, ws);
			expect(r.run, cmd).toBe(false);
		}
		expect(judge.asks).toBeGreaterThan(0);
	});
});

describe("glob expansion matches the shell or has no opinion (#4073, 8SO)", () => {
	beforeEach(() => {
		writeFileSync(join(ws, "inbox", "keep.tmp"), "x");
	});

	// NTFS refuses a name with a newline, so on Windows the file can never exist: the
	// OS turns the write away, and the glob still goes to the judge (no lane there).
	const impossibleName = process.platform === "win32";

	test("a newline-named file the glob would match goes to the judge", () => {
		const put = () => writeFileSync(join(ws, "inbox", "note-x\ny.txt"), "x");
		if (impossibleName) expect(put).toThrow();
		else put();
		expect(moveInProject("mv inbox/note-*.txt inbox/notes/", ws).ok).toBe(false);
	});

	test("a newline-named symlink the glob would match goes to the judge", () => {
		const link = () => symlinkSync(outside, join(ws, "inbox", "note-z\nq.txt"));
		if (impossibleName) expect(link).toThrow();
		else link();
		expect(moveInProject("mv inbox/note-*.txt inbox/notes/", ws).ok).toBe(false);
		expect(moveInProject("cp inbox/note-*.txt inbox/notes/", ws).ok).toBe(false);
	});

	test("a -tevil file goes to the judge", () => {
		writeFileSync(join(ws, "inbox", "-tevil"), "x");
		expect(moveInProject("mv inbox/* inbox/notes/", ws).ok).toBe(false);
		expect(moveInProject("mv * inbox/notes/", ws).ok).toBe(false);
		writeFileSync(join(ws, "-tevil"), "x");
		expect(moveInProject("mv * inbox/notes/", ws).ok).toBe(false);
	});

	test("an 'a b.txt' file the glob would match goes to the judge", () => {
		writeFileSync(join(ws, "inbox", "note a b.txt"), "x");
		expect(moveInProject("mv inbox/note-*.txt inbox/notes/", ws).ok).toBe(GLOB_LANE);
		expect(moveInProject("mv inbox/note*.txt inbox/notes/", ws).ok).toBe(false);
		expect(moveInProject("mv inbox/note?a?b.txt inbox/notes/", ws).ok).toBe(false);
	});

	test("an astral or non-ASCII name matched by ? or * goes to the judge", () => {
		writeFileSync(join(ws, "inbox", "note-\u{1F600}.txt"), "x");
		expect(moveInProject("mv inbox/note-?.txt inbox/notes/", ws).ok).toBe(false);
		expect(moveInProject("mv inbox/note-*.txt inbox/notes/", ws).ok).toBe(false);
	});

	test("a pattern that starts with a dot has no opinion", () => {
		writeFileSync(join(ws, "inbox", ".hid-1.txt"), "x");
		expect(moveInProject("mv inbox/.hid-*.txt inbox/notes/", ws).ok).toBe(false);
	});

	test("a workspace inside EIGHT_HOME or EIGHT_DATA_DIR has no glob lane, run-dir exception included", () => {
		const eh = realpathSync(tempDir("s1-eh-"));
		const dd = realpathSync(tempDir("s1-dd-"));
		const saved = [process.env.EIGHT_HOME, process.env.EIGHT_DATA_DIR];
		const inEh = join(eh, ".8gent", "work");
		const ehRun = join(eh, ".8gent", "rishi-pilot", "runs", "r1", "work");
		const inDd = join(dd, "work");
		for (const d of [inEh, ehRun, inDd]) {
			mkdirSync(join(d, "inbox", "notes"), { recursive: true });
			writeFileSync(join(d, "inbox", "note-1.txt"), "x");
		}
		process.env.EIGHT_HOME = eh;
		process.env.EIGHT_DATA_DIR = dd;
		try {
			expect(moveInProject("mv inbox/note-*.txt inbox/notes/", inEh).ok).toBe(false);
			// the narrow exception is only for the default ~/.8gent
			expect(moveInProject("mv inbox/note-*.txt inbox/notes/", ehRun).ok).toBe(false);
			expect(moveInProject("mv inbox/note-*.txt inbox/notes/", inDd).ok).toBe(false);
			// a plain written operand is still the old lane
			expect(moveInProject("mv inbox/note-1.txt inbox/notes/", inDd).ok).toBe(true);
		} finally {
			for (const [k, v] of [["EIGHT_HOME", saved[0]], ["EIGHT_DATA_DIR", saved[1]]] as const) {
				if (v === undefined) Reflect.deleteProperty(process.env, k);
				else process.env[k] = v;
			}
		}
	});

	test("a workspace inside ~/.8gent has no glob lane, but a pilot run dir does", () => {
		const home = realpathSync(tempDir("s1-home-"));
		const h = process.env.HOME;
		const bad = join(home, ".8gent", "skills-work");
		const run = join(home, ".8gent", "rishi-pilot", "runs", "r1", "work");
		for (const d of [bad, run, join(home, ".8gent")]) {
			mkdirSync(join(d, "inbox", "notes"), { recursive: true });
			writeFileSync(join(d, "inbox", "note-1.txt"), "x");
		}
		_setPasswdHomeForTests(home);
		process.env.HOME = home;
		try {
			expect(moveInProject("mv inbox/note-*.txt inbox/notes/", bad).ok).toBe(false);
			expect(moveInProject("mv inbox/note-*.txt inbox/notes/", join(home, ".8gent")).ok).toBe(false);
			expect(moveInProject("mv inbox/note-*.txt inbox/notes/", run).ok).toBe(GLOB_LANE);
		} finally {
			_setPasswdHomeForTests(undefined);
			process.env.HOME = h;
		}
	});
});

describe("systemOneGate end to end with a judge that says dangerous", () => {
	test("in-project mv runs without asking the judge", async () => {
		const r = await systemOneGate("mv inbox/note-1.txt inbox/notes/", process.env, ws);
		expect(r.run).toBe(true);
		expect(r.guard?.backend).toBe("allowlist");
		expect(judge.asks).toBe(0);
	});

	for (const cmd of [
		"mv inbox/note-1.txt /tmp/stolen.txt",
		"mv inbox/note-1.txt package.json",
		"mv inbox/note-1.txt inbox/note-2.txt",
		"mv inbox/note-1.txt $TARGET",
		"mv .env inbox/notes/",
	]) {
		test(`still gated: ${cmd}`, async () => {
			const r = await systemOneGate(cmd, process.env, ws);
			expect(r.run).toBe(false);
			expect(r.message ?? "").toContain(SYSTEM_ONE_BLOCK_MARKER);
			expect(judge.asks).toBeGreaterThan(0);
		});
	}

	test("EIGHT_S1_ALLOWLIST=0 turns the lane off with the rest of the allowlist", async () => {
		process.env[SYSTEM_ONE_ALLOWLIST_FLAG] = "0";
		const r = await systemOneGate("mv inbox/note-1.txt inbox/notes/", process.env, ws);
		expect(r.run).toBe(false);
	});
});

describe("one sensitive-name set for mv and rm (#3944)", () => {
	const NAMES = [
		".env",
		".env.local",
		".npmrc",
		".netrc",
		"app.pem",
		"server.key",
		"cert.p12",
		"data.db",
		"data.sqlite3",
		"id_rsa",
		"id_ed25519.txt",
		"credentials.txt",
		"my-credential.lock",
		"secret.txt",
		"client-secret.lock",
		"secrets.pid",
	];
	for (const name of NAMES) {
		test(`mv and rm both refuse ${name}`, () => {
			mkdirSync(join(ws, "tmp"), { recursive: true });
			writeFileSync(join(ws, "tmp", name), "x");
			writeFileSync(join(ws, "inbox", name), "x");
			expect(singleFileDelete(`rm -f tmp/${name}`, ws).ok, `rm tmp/${name}`).toBe(false);
			expect(moveInProject(`mv inbox/${name} inbox/notes/`, ws).ok, `mv src ${name}`).toBe(false);
			expect(moveInProject(`mv inbox/note-1.txt inbox/notes/${name}`, ws).ok, `mv dest ${name}`).toBe(false);
		});
	}
	test("a plain scratch name still passes both", () => {
		mkdirSync(join(ws, "tmp"), { recursive: true });
		writeFileSync(join(ws, "tmp", "plain.txt"), "x");
		expect(singleFileDelete("rm -f tmp/plain.txt", ws).ok).toBe(true);
	});
});

describe("generatedDataName is a positive allowlist (8SO, #3944)", () => {
	test("config names laundered through json never match", () => {
		for (const n of [
			".mocharc.json",
			".huskyrc.json",
			".nycrc.json",
			".lintstagedrc.json",
			".releaserc.json",
			".commitlintrc.json",
			"nodemon.json",
			"ecosystem.config.json",
			"tailwind.config.json",
			"postcss.config.json",
			"vite.config.json",
			"bower.json",
			"composer.json",
			"pyrightconfig.json",
			"wrangler.json",
			"e2e.config.json",
			"todo-rc.json",
			".todo.rc.json",
			"package.json",
			"tsconfig.json",
			"notes.json",
			".json",
		])
			expect(generatedDataName(n), n).toBe(false);
	});
	test("generated data names match", () => {
		for (const n of ["e2e.json", ".todo-e2e.json", "result.json", "out.json", "tmp_state.json", "todo.json", "results2.json"])
			expect(generatedDataName(n), n).toBe(true);
	});
	test("mv refuses every laundered name as source or landing name", () => {
		for (const n of [
			".mocharc.json",
			".huskyrc.json",
			"nodemon.json",
			"ecosystem.config.json",
			"vite.config.json",
			"bower.json",
			"wrangler.json",
			"src/.mocharc.json",
		]) {
			mkdirSync(join(ws, "src"), { recursive: true });
			writeFileSync(join(ws, "a.json"), "[]");
			writeFileSync(join(ws, "e2e.json"), "[]");
			expect(moveInProject(`mv e2e.json ${n}`, ws).ok, `mv e2e.json ${n}`).toBe(false);
			expect(moveInProject(`mv a.json ${n}`, ws).ok, `mv a.json ${n}`).toBe(false);
			expect(singleFileDelete(`rm -f ${n}`, ws).ok, `rm ${n}`).toBe(false);
		}
	});
});
