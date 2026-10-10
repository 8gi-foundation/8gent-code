/**
 * #3826: System One must not block `git clone <local repo> <new dir>` into the
 * workspace. The pilot case: `git clone ../shared-notes.git notes`. The judge
 * here is a stub that answers "dangerous" to everything, so a command that
 * reaches it is blocked.
 */

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { cleanupTempDirs, tempDir } from "../../tests/temp-dirs";
import { createDecider } from "../decide/index";
import type { DecideBackend, SystemOneRequest, SystemOneResponse } from "../decide/types";
import { cloneLocalIntoProject } from "./s1-clone-local";
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

let container: string; // holds the workspace and its sibling repos
let ws: string;
let outside: string; // unrelated directory, not a sibling
let judge: AlwaysDangerous;
const saved: Record<string, string | undefined> = {};
const KEYS = [SYSTEM_ONE_FLAG, SYSTEM_ONE_ALLOWLIST_FLAG, "EIGHT_HEADLESS", "EIGHT_WORKSPACE_ROOT"];

function git(cwd: string, ...args: string[]): void {
	const r = spawnSync(
		"git",
		["-c", "user.name=t", "-c", "user.email=t@example.com", "-c", "commit.gpgsign=false", ...args],
		{ cwd, encoding: "utf8" },
	);
	if (r.status !== 0) throw new Error(`git ${args.join(" ")}: ${r.stderr}`);
}

/** A work tree repository with one commit at `dir`; `link` adds a tracked symlink. */
function workRepo(dir: string, link = false): void {
	mkdirSync(dir, { recursive: true });
	git(dir, "init", "-q", "-b", "main");
	writeFileSync(join(dir, "a.txt"), "x");
	if (link) symlinkSync("/etc/hosts", join(dir, "l"));
	git(dir, "add", "-A");
	git(dir, "commit", "-q", "-m", "init");
}

/** A bare repository with one commit at `dir`. */
function bare(dir: string, link = false): void {
	const tmp = `${dir}.seed`;
	workRepo(tmp, link);
	git(container, "clone", "-q", "--bare", tmp, dir);
	rmSync(tmp, { recursive: true, force: true });
}

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
	container = tempDir("s1-clone-c-");
	outside = tempDir("s1-clone-out-");
	ws = join(container, "proj");
	mkdirSync(ws);
	bare(join(container, "shared-notes.git"));
	// a work tree repository beside the project (not bare)
	workRepo(join(container, "wt-repo"));
	// a bare repository inside the project
	bare(join(ws, "vendor-src.git"));
	// a work tree repository inside the project
	workRepo(join(ws, "inner-repo"));
	// not a repository
	mkdirSync(join(container, "plain-dir"));
	// a repository somewhere that is not the workspace or its parent
	bare(join(outside, "far.git"));
	// dot-leading and case-variant siblings
	bare(join(container, ".SecretRepo"));
	bare(join(container, "deep"));
	mkdirSync(join(container, "deeper"));
	bare(join(container, "deeper", "x.git"));
	// tracked symlinks
	bare(join(container, "linky.git"), true);
	workRepo(join(ws, "linky-inner"), true);
	// an empty bare repository (history scan cannot run)
	mkdirSync(join(container, "empty.git"));
	git(container, "init", "-q", "--bare", "empty.git");
	mkdirSync(join(ws, "existing"));
	writeFileSync(join(ws, "existing", "f.txt"), "x");
	mkdirSync(join(ws, "packages", "permissions"), { recursive: true });
	mkdirSync(join(ws, "hooks"));
	symlinkSync(outside, join(ws, "escape"));
	symlinkSync(join(container, "shared-notes.git"), join(ws, "src-link"));
	symlinkSync(join(container, "shared-notes.git"), join(container, "sibling-link.git"));
	judge = new AlwaysDangerous();
	_setSystemOneOverridesForTests({
		createDecider: () => createDecider({ backend: judge, cacheSize: 0 }),
		askHuman: async () => null,
		calibrationDir: tempDir("s1-clone-nocal-"),
	});
	process.env[SYSTEM_ONE_FLAG] = "1";
});

afterEach(() => {
	rmSync(container, { recursive: true, force: true });
	rmSync(outside, { recursive: true, force: true });
	Reflect.deleteProperty(process.env, SYSTEM_ONE_ALLOWLIST_FLAG);
});

describe("cloneLocalIntoProject allows", () => {
	for (const cmd of [
		"git clone ../shared-notes.git notes",
		"git clone -q ../shared-notes.git notes",
		"git clone --quiet ../shared-notes.git notes",
		"git clone ./../shared-notes.git ./notes",
		"git clone vendor-src.git notes",
		"git clone vendor-src.git existing/inner",
		"git clone inner-repo notes",
	]) {
		test(cmd, () => {
			expect(cloneLocalIntoProject(cmd, ws).ok).toBe(true);
		});
	}
});

describe("cloneLocalIntoProject refuses", () => {
	const refused: Array<[string, string]> = [
		["https URL", "git clone https://github.com/a/b.git notes"],
		["http URL", "git clone http://example.com/a.git notes"],
		["ssh URL", "git clone ssh://git@example.com/a.git notes"],
		["scp-like git@ URL", "git clone git@github.com:a/b.git notes"],
		["host:path", "git clone example.com:a/b.git notes"],
		["file:// URL", "git clone file:///etc/x.git notes"],
		["git:// URL", "git clone git://example.com/a.git notes"],
		["absolute local source", `git clone ${"/tmp"}/shared-notes.git notes`],
		["source outside workspace and its parent", "git clone ../../far.git notes"],
		["non-bare sibling", "git clone ../wt-repo notes"],
		["dot-dir sibling", "git clone ../.SecretRepo notes"],
		["dot-dir sibling, case variant", "git clone ../.secretrepo notes"],
		["source deeper than one level", "git clone ../deeper/x.git notes"],
		["sibling through a nested .. path", "git clone ../deeper/../shared-notes.git notes"],
		["workspace source with a dot segment", "git clone ./inner-repo/../vendor-src.git notes"],
		["committed symlink in a sibling", "git clone ../linky.git notes"],
		["committed symlink in a workspace repo", "git clone linky-inner notes"],
		["empty repository (scan cannot run)", "git clone ../empty.git notes"],
		["destination node_modules", "git clone ../shared-notes.git node_modules"],
		["destination under node_modules", "git clone ../shared-notes.git node_modules/foo"],
		["destination under Node_Modules (case)", "git clone ../shared-notes.git existing/Node_Modules/foo"],
		["destination vendor", "git clone ../shared-notes.git vendor"],
		["destination venv", "git clone ../shared-notes.git venv"],
		["destination dist", "git clone ../shared-notes.git dist"],
		["destination build/x", "git clone ../shared-notes.git build/x"],
		["destination site-packages", "git clone ../shared-notes.git existing/site-packages"],
		["source is a plain directory, not a repository", "git clone ../plain-dir notes"],
		["source is a symlink inside", "git clone src-link notes"],
		["source is a symlink beside", "git clone ../sibling-link.git notes"],
		["source missing", "git clone ../nope.git notes"],
		["the parent directory itself", "git clone .. notes"],
		["destination exists", "git clone ../shared-notes.git existing"],
		["destination inside an existing directory that exists as file", "git clone ../shared-notes.git existing/f.txt"],
		["destination outside with ..", "git clone ../shared-notes.git ../notes"],
		["destination absolute", `git clone ../shared-notes.git ${"/tmp"}/notes`],
		["destination through a symlinked directory", "git clone ../shared-notes.git escape/notes"],
		["destination is the workspace", "git clone ../shared-notes.git ."],
		["destination in .git", "git clone ../shared-notes.git .git/x"],
		["destination dotted", "git clone ../shared-notes.git .hidden"],
		["destination in a dot directory", "git clone ../shared-notes.git existing/.x/y"],
		["destination in security source", "git clone ../shared-notes.git packages/permissions/x"],
		["destination hooks", "git clone ../shared-notes.git hooks/x"],
		["destination protected name", "git clone ../shared-notes.git package.json"],
		["destination inside the source", "git clone vendor-src.git vendor-src.git/inner"],
		["destination missing parent", "git clone ../shared-notes.git nope/notes"],
		["destination with trailing slash", "git clone ../shared-notes.git notes/"],
		["no destination", "git clone ../shared-notes.git"],
		["three operands", "git clone ../shared-notes.git notes more"],
		["--upload-pack", "git clone --upload-pack=touch ../shared-notes.git notes"],
		["--upload-pack separate", "git clone --upload-pack touch ../shared-notes.git notes"],
		["-u", "git clone -u touch ../shared-notes.git notes"],
		["--config", "git clone --config core.fsmonitor=x ../shared-notes.git notes"],
		["--config=", "git clone --config=core.fsmonitor=x ../shared-notes.git notes"],
		["-c", "git clone -c core.sshCommand=x ../shared-notes.git notes"],
		["--template", "git clone --template=../t ../shared-notes.git notes"],
		["--recurse-submodules", "git clone --recurse-submodules ../shared-notes.git notes"],
		["--separate-git-dir", "git clone --separate-git-dir=../g ../shared-notes.git notes"],
		["--reference", "git clone --reference ../shared-notes.git ../shared-notes.git notes"],
		["--no-checkout is still a flag", "git clone -n ../shared-notes.git notes"],
		["--", "git clone -- ../shared-notes.git notes"],
		["git -c before clone", "git -c protocol.ext.allow=always clone ../shared-notes.git notes"],
		["git -C before clone", "git -C .. clone shared-notes.git notes"],
		["chained with ;", "git clone ../shared-notes.git notes ; rm -rf ."],
		["chained with &&", "git clone ../shared-notes.git notes && echo hi"],
		["chained with ||", "git clone ../shared-notes.git notes || echo hi"],
		["piped", "git clone ../shared-notes.git notes | cat"],
		["backgrounded", "git clone ../shared-notes.git notes &"],
		["redirect", "git clone ../shared-notes.git notes > out.txt"],
		["variable", "git clone $SRC notes"],
		["command substitution", "git clone ../shared-notes.git $(pwd)/notes"],
		["quoted", 'git clone "../shared-notes.git" notes'],
		["glob", "git clone ../shared-*.git notes"],
		["not a clone", "git fetch ../shared-notes.git"],
	];
	for (const [name, cmd] of refused) {
		test(name, () => {
			expect(cloneLocalIntoProject(cmd, ws).ok).toBe(false);
		});
	}

	test("workspace parent is $HOME", () => {
		const h = process.env.HOME;
		process.env.HOME = container;
		try {
			expect(cloneLocalIntoProject("git clone ../shared-notes.git notes", ws).ok).toBe(false);
		} finally {
			process.env.HOME = h;
		}
	});

	test("workspace parent is an ancestor of $HOME", () => {
		const h = process.env.HOME;
		process.env.HOME = join(container, "some", "home");
		try {
			expect(cloneLocalIntoProject("git clone ../shared-notes.git notes", ws).ok).toBe(false);
		} finally {
			process.env.HOME = h;
		}
	});

	test("no working directory", () => {
		expect(cloneLocalIntoProject("git clone ../shared-notes.git notes", undefined).ok).toBe(false);
	});

	test("a relative working directory", () => {
		expect(cloneLocalIntoProject("git clone ../shared-notes.git notes", "proj").ok).toBe(false);
	});
});

describe("systemOneGate end to end with a judge that says dangerous", () => {
	test("local clone runs without asking the judge", async () => {
		const r = await systemOneGate("git clone ../shared-notes.git notes", process.env, ws);
		expect(r.run).toBe(true);
		expect(r.guard?.backend).toBe("allowlist");
		expect(judge.asks).toBe(0);
		expect(existsSync(join(ws, "notes"))).toBe(false); // the gate decides, it does not run
	});

	for (const cmd of [
		"git clone https://github.com/a/b.git notes",
		"git clone ../shared-notes.git existing",
		"git clone ../shared-notes.git ../notes",
		"git clone --upload-pack=touch ../shared-notes.git notes",
		"git clone ../shared-notes.git notes && echo hi",
	]) {
		test(`still gated: ${cmd}`, async () => {
			const r = await systemOneGate(cmd, process.env, ws);
			expect(r.run).toBe(false);
			expect(r.message ?? "").toContain(SYSTEM_ONE_BLOCK_MARKER);
			expect(judge.asks).toBeGreaterThan(0);
		});
	}

	test("git mv with several sources runs without asking the judge", async () => {
		mkdirSync(join(ws, "inbox", "docs"), { recursive: true });
		for (const f of ["doc-1.md", "doc-2.md", "doc-3.md"]) writeFileSync(join(ws, "inbox", f), "x");
		const r = await systemOneGate(
			"git mv inbox/doc-1.md inbox/doc-2.md inbox/doc-3.md inbox/docs/",
			process.env,
			ws,
		);
		expect(r.run).toBe(true);
		expect(judge.asks).toBe(0);
	});

	test("EIGHT_S1_ALLOWLIST=0 turns the lane off", async () => {
		process.env[SYSTEM_ONE_ALLOWLIST_FLAG] = "0";
		const r = await systemOneGate("git clone ../shared-notes.git notes", process.env, ws);
		expect(r.run).toBe(false);
	});
});
