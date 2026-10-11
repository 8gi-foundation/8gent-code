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
import { mkdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { cleanupTempDirs, tempDir } from "../../tests/temp-dirs";
import { createDecider } from "../decide/index";
import type { DecideBackend, SystemOneRequest, SystemOneResponse } from "../decide/types";
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
	mkdirSync(join(ws, "packages", "permissions"), { recursive: true });
	writeFileSync(join(ws, "packages", "permissions", "policy-engine.ts"), "x");
	mkdirSync(join(ws, "hooks"));
	writeFileSync(join(ws, "hooks", "pre-push"), "x");
	mkdirSync(join(ws, "withenv"));
	writeFileSync(join(ws, "withenv", ".env"), "S=1");
	mkdirSync(join(ws, "plain"));
	writeFileSync(join(ws, "plain", "a.txt"), "x");
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
		["a variable target", "mv inbox/note-1.txt $HOME/"],
		["a variable source", "mv $F inbox/notes/"],
		["a glob source", "mv inbox/note-*.txt inbox/notes/"],
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
		["not an mv", "cp inbox/note-1.txt inbox/notes/"],
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
