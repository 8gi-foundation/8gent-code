/**
 * #4185: `.tmp` directly under the working directory is the one sanctioned
 * scratch directory. Pilot l5-feature-e2e failed twice on 13 Oct only on
 * no_system_one_blocked: at 12:07 the run-in-project lane refused
 * `TODO_FILE=.tmp/t.json bun src/cli.ts done 1 | cat -A`, at 15:48 the
 * clean-up `rm -rf .tmp` (rm_recursive) and `rmdir .tmp` (rmdir_non_temp)
 * went to the judge and were blocked.
 *
 * The rows live in __tests__/fixtures/4185-tmp-scratch-commands.json with the
 * real CLI from the 15:48 run. The judge here says "dangerous" to everything,
 * so a refused row that reached the allowlist would be the bug; an allowed row
 * must never ask the judge.
 */

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import {
	existsSync,
	mkdirSync,
	readdirSync,
	realpathSync,
	rmSync,
	symlinkSync,
	writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { cleanupTempDirs, tempDir } from "../../tests/temp-dirs";
import { createDecider } from "../decide/index";
import type { DecideBackend, SystemOneRequest, SystemOneResponse } from "../decide/types";
import { ToolExecutor } from "../eight/tools";
import fixture from "./__tests__/fixtures/4185-tmp-scratch-commands.json";
import { CreatedFiles, watchRedirects } from "./s1-created-files";
import { rmOwnDir } from "./s1-rm-own-dir";
import { runInProject } from "./s1-run-in-project";
import {
	SYSTEM_ONE_ALLOWLIST_FLAG,
	SYSTEM_ONE_BLOCK_MARKER,
	SYSTEM_ONE_FLAG,
	_resetSystemOne,
	_setSystemOneOverridesForTests,
	systemOneGate,
} from "./system-one-gate";
import { registerTuiApprovalHandler } from "./tui-approval-channel";

type Row = { lane: "run" | "rm"; command: string; why: string; setup?: string };
const allowed = fixture.allowed as Row[];
const refused = fixture.refused as Row[];

afterAll(cleanupTempDirs);

class AlwaysDangerous implements DecideBackend {
	readonly name = "stub";
	readonly model = "stub-model";
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
let rec: CreatedFiles;
let judge: AlwaysDangerous;
const saved: Record<string, string | undefined> = {};
const KEYS = [SYSTEM_ONE_FLAG, SYSTEM_ONE_ALLOWLIST_FLAG, "EIGHT_HEADLESS", "EIGHT_WORKSPACE_ROOT"];

beforeAll(() => {
	for (const k of KEYS) saved[k] = process.env[k];
	Reflect.deleteProperty(process.env, "EIGHT_WORKSPACE_ROOT");
	Reflect.deleteProperty(process.env, SYSTEM_ONE_ALLOWLIST_FLAG);
	Reflect.deleteProperty(process.env, SYSTEM_ONE_FLAG);
	process.env.EIGHT_HEADLESS = "1";
});
afterAll(() => {
	for (const k of KEYS) {
		if (saved[k] === undefined) Reflect.deleteProperty(process.env, k);
		else process.env[k] = saved[k];
	}
	_resetSystemOne();
});

/** Run `cmd` in the workspace the way run_command does, with the record watching. */
function sh(cmd: string) {
	const done = watchRedirects(cmd, ws, rec);
	try {
		execFileSync("sh", ["-c", cmd], { cwd: ws, stdio: "ignore" });
	} catch {
		// A failing command still finishes the watch.
	}
	done();
}

function put(rel: string, body = "x") {
	mkdirSync(join(ws, rel, ".."), { recursive: true });
	writeFileSync(join(ws, rel), body);
}

const git = (...args: string[]) =>
	execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", ...args], {
		cwd: ws,
		stdio: "ignore",
	});

/**
 * The workspace before the session (the pilot's repo, other dot
 * entries; `secret` adds a .env), then what `setup` names, then the session: mkdir -p .tmp/x, the
 * CLI writing .tmp/t.json, a redirect into .tmp.
 */
function workspace(setup?: string, secret = false) {
	ws = realpathSync(tempDir("s1-tmp-ws-"));
	outside = realpathSync(tempDir("s1-tmp-out-"));
	git("init", "-q");
	for (const [rel, body] of Object.entries(fixture.files)) put(rel, body);
	git("add", "src");
	git("commit", "-qm", "fixture");
	// A .env in the working directory turns the run lane off (bun would load it), so only the rm rows get one.
	if (secret) put(".env", "SECRET=1\n");
	mkdirSync(join(ws, ".cache"));
	mkdirSync(join(ws, "build"));
	if (setup === "tmp-preexisting") put(".tmp/old.txt");
	if (setup === "tmp-symlink-out") symlinkSync(outside, join(ws, ".tmp"));
	if (setup === "tmp-symlink-tmp") symlinkSync("/tmp", join(ws, ".tmp"));
	Bun.sleepSync(20);
	rec = new CreatedFiles();
	if (setup === "tmp-symlink-in") {
		sh("mkdir real");
		symlinkSync(join(ws, "real"), join(ws, ".tmp"));
	}
	if (!setup?.startsWith("tmp-symlink")) {
		sh("mkdir -p .tmp/x");
		sh("TODO_FILE=.tmp/t.json bun src/cli.ts add buy-milk");
		sh("echo hi > .tmp/out.txt");
	}
	sh("mkdir -p .scratch src/.tmp .tmpx");
	if (setup === "tmp-foreign-file") writeFileSync(join(ws, ".tmp/theirs.txt"), "not the session's");
	if (setup === "tmp-tracked") {
		put(".tmp/kept.txt");
		git("add", "-f", ".tmp/kept.txt");
	}
	judge = new AlwaysDangerous();
	_setSystemOneOverridesForTests({
		createDecider: () => createDecider({ backend: judge, cacheSize: 0 }),
		askHuman: async () => null,
		calibrationDir: calibrated(),
	});
}

/**
 * A calibrated judge, so a command that reaches it really is judged (and,
 * this judge being "always dangerous", blocked) rather than falling back to
 * rules only. Same file as s1-run-own-script.test.ts.
 */
function calibrated(): string {
	const d = tempDir("s1-tmp-cal-");
	writeFileSync(
		join(d, "stub-stub-model.json"),
		JSON.stringify({
			model: "stub-model",
			backend: "stub",
			temperature: 1,
			bias: 0,
			blockAbove: 0.5,
			escalateBand: [0.35, 0.65],
			fittedOn: "test",
			n: 2,
			heldOut: { recall: 1, falseBlock: 0, accuracy: 1, escalate: 0, method: "leave-one-out" },
		}),
	);
	return d;
}

const lane = (r: Row) =>
	r.lane === "run"
		? runInProject(r.command, ws).ok
		: rmOwnDir(r.command.replace("WS", ws), ws, rec).ok;

describe.skipIf(process.platform === "win32")(
	"#4185 .tmp, the one sanctioned scratch directory",
	() => {
		afterEach(() => {
			rmSync(ws, { recursive: true, force: true });
			rmSync(outside, { recursive: true, force: true });
			Reflect.deleteProperty(process.env, SYSTEM_ONE_ALLOWLIST_FLAG);
			Reflect.deleteProperty(process.env, SYSTEM_ONE_FLAG);
		});

		describe("the session's record", () => {
			beforeEach(() => workspace());
			test("mkdir -p .tmp/x records .tmp and .tmp/x", () => {
				expect(rec.createdDirBySession(join(ws, ".tmp"))).toBe(true);
				expect(rec.createdDirBySession(join(ws, ".tmp/x"))).toBe(true);
			});
			test("the file the CLI wrote where TODO_FILE=.tmp/t.json points is the session's", () => {
				expect(existsSync(join(ws, ".tmp/t.json"))).toBe(true);
				expect(rec.bornToSession(join(ws, ".tmp/t.json"))).toBe(true);
			});
			test("a redirect into .tmp is the session's", () => {
				expect(rec.createdBySession(join(ws, ".tmp/out.txt"))).toBe(true);
			});
			test("a child's file under another dot directory is still never recorded", () => {
				sh("TODO_FILE=.scratch/t.json bun src/cli.ts add x");
				expect(existsSync(join(ws, ".scratch/t.json"))).toBe(true);
				expect(rec.bornToSession(join(ws, ".scratch/t.json"))).toBe(false);
				sh("TODO_FILE=src/.tmp/t.json bun src/cli.ts add x");
				expect(rec.bornToSession(join(ws, "src/.tmp/t.json"))).toBe(false);
			});
		});

		describe("allowed", () => {
			beforeEach(() => workspace());
			for (const r of allowed) {
				test(`${r.lane}: ${r.command} (${r.why})`, async () => {
					expect(lane(r)).toBe(true);
					const g = await systemOneGate(r.command, process.env, ws, rec);
					expect(g.run).toBe(true);
					expect(g.guard?.backend).toBe("allowlist");
					expect(judge.asks).toBe(0);
				});
			}
		});

		describe("refused: the lane has no opinion and the judge decides", () => {
			for (const r of refused) {
				test(`${r.lane}: ${r.command} (${r.why}${r.setup ? `, ${r.setup}` : ""})`, async () => {
					workspace(r.setup, r.lane === "rm");
					expect(lane(r)).toBe(false);
					const g = await systemOneGate(r.command.replace("WS", ws), process.env, ws, rec);
					expect(g.guard?.backend).not.toBe("allowlist");
				});
			}
		});

		describe("modes", () => {
			beforeEach(() => workspace());
			test("strict mode (Guarded) never uses the lanes", async () => {
				process.env[SYSTEM_ONE_FLAG] = "1";
				for (const r of allowed) {
					const g = await systemOneGate(r.command, process.env, ws, rec);
					expect(g.guard?.backend, r.command).not.toBe("allowlist");
				}
			});
			test("without the session's record, rm -rf .tmp has no lane", async () => {
				const g = await systemOneGate("rm -rf .tmp", process.env, ws);
				expect(g.guard?.backend).not.toBe("allowlist");
			});
		});

		/** The real tool entry point, replaying both pilot runs in order. */
		describe("ToolExecutor: the two pilot runs", () => {
			let ttyWas: PropertyDescriptor | undefined;
			beforeEach(() => {
				workspace();
				rmSync(join(ws, ".tmp"), { recursive: true, force: true });
				registerTuiApprovalHandler(async () => "approve");
				Reflect.deleteProperty(process.env, "EIGHT_HEADLESS");
				ttyWas = Object.getOwnPropertyDescriptor(process.stdin, "isTTY");
				Object.defineProperty(process.stdin, "isTTY", { value: true, configurable: true });
			});
			afterEach(() => {
				registerTuiApprovalHandler(null);
				if (ttyWas) Object.defineProperty(process.stdin, "isTTY", ttyWas);
				else Reflect.deleteProperty(process.stdin, "isTTY");
				process.env.EIGHT_HEADLESS = "1";
			});

			const steps = async (ex: ToolExecutor, cmds: string[]) => {
				for (const command of cmds) {
					const out = await ex.execute("run_command", { command });
					expect(out, command).not.toContain(SYSTEM_ONE_BLOCK_MARKER);
				}
			};

			test("15:48: mkdir, the CLI into .tmp, rm -rf .tmp", async () => {
				const ex = new ToolExecutor(ws, "tmp4185a");
				await steps(ex, [
					"mkdir -p .tmp",
					"TODO_FILE=.tmp/t.json bun src/cli.ts add buy-milk",
					"TODO_FILE=.tmp/t.json bun src/cli.ts done 1",
					"rm -rf .tmp",
				]);
				expect(existsSync(join(ws, ".tmp"))).toBe(false);
				expect(existsSync(join(ws, "src/cli.ts"))).toBe(true);
				expect(judge.asks).toBe(0);
			});
			test("15:48 second path: rm -f .tmp/t.json, then rmdir .tmp", async () => {
				const ex = new ToolExecutor(ws, "tmp4185b");
				await steps(ex, [
					"mkdir -p .tmp",
					"TODO_FILE=.tmp/t.json bun src/cli.ts add buy-milk",
					"rm -f .tmp/t.json",
					"rmdir .tmp",
				]);
				// The harness marker (#4316) keeps .tmp non-empty, so the real rmdir leaves the
				// directory behind; the gate let it through and nothing else is in it.
				expect(readdirSync(join(ws, ".tmp"))).toEqual([".gitignore"]);
				expect(judge.asks).toBe(0);
			});
			test("a .tmp/.gitignore that is not the harness marker still blocks rm -rf .tmp (#4316)", async () => {
				const ex = new ToolExecutor(ws, "tmp4316");
				await steps(ex, ["mkdir -p .tmp"]);
				writeFileSync(join(ws, ".tmp/.gitignore"), "something-else\n");
				const out = await ex.execute("run_command", { command: "rm -rf .tmp" });
				expect(out).toContain(SYSTEM_ONE_BLOCK_MARKER);
				expect(existsSync(join(ws, ".tmp"))).toBe(true);
			});
			test("12:07: the piped CLI run against .tmp", async () => {
				const ex = new ToolExecutor(ws, "tmp4185c");
				await steps(ex, [
					"mkdir -p .tmp",
					"TODO_FILE=.tmp/t.json bun src/cli.ts add buy-milk",
					"TODO_FILE=.tmp/t.json bun src/cli.ts done 1 | cat -A",
				]);
				expect(judge.asks).toBe(0);
			});
			test("8SO: `.tmp` plus a trailing no-break space is another folder: blocked, it is kept", async () => {
				// JS trim made the lane read `.tmp`; the shell removed `.tmp<U+00A0>`.
				for (const ch of ["\u00a0", "\ufeff", "\u3000"]) {
					mkdirSync(join(ws, `.tmp${ch}`));
					writeFileSync(join(ws, `.tmp${ch}`, "theirs.txt"), "x");
				}
				const ex = new ToolExecutor(ws, "tmp4185e");
				await steps(ex, ["mkdir -p .tmp"]);
				for (const ch of ["\u00a0", "\ufeff", "\u3000"]) {
					const out = await ex.execute("run_command", { command: `rm -rf .tmp${ch}` });
					expect(out, JSON.stringify(ch)).toContain(SYSTEM_ONE_BLOCK_MARKER);
					expect(existsSync(join(ws, `.tmp${ch}`, "theirs.txt"))).toBe(true);
				}
				expect(existsSync(join(ws, ".tmp"))).toBe(true);
			});
			test("a file another process dropped into .tmp: blocked, the file kept", async () => {
				const ex = new ToolExecutor(ws, "tmp4185d");
				await steps(ex, ["mkdir -p .tmp"]);
				writeFileSync(join(ws, ".tmp/theirs.txt"), "x");
				const out = await ex.execute("run_command", { command: "rm -rf .tmp" });
				expect(out).toContain(SYSTEM_ONE_BLOCK_MARKER);
				expect(existsSync(join(ws, ".tmp/theirs.txt"))).toBe(true);
			});
		});
	},
);
