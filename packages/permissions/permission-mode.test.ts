/**
 * Permission modes (#3170): plan < ask < guarded < infinite, per agent, per call.
 *
 * Unit: the cycle, the clamp for every parent/child pair, the parent link,
 * the infinite expiry, per-call binding.
 *
 * Integration through the REAL tool entry points (ToolExecutor.execute for the
 * text-tool loop, agentTools for the native loop, spawnAgentTool for both):
 * Plan refuses before anything touches disk, Guarded routes shell commands
 * through System One even with EIGHT_SYSTEM_ONE=0, Ask with System One on by
 * default runs it before the card exactly as EIGHT_SYSTEM_ONE=1 does, Infinite answers
 * exactly as the process-wide infinite flag does, two agents in one process
 * never share a mode, and a child is never more permissive than its parent.
 *
 * System One runs behind the REAL createDecider + bashGuard with a stub
 * backend that keys on marker text, as in system-one-gate.test.ts.
 */

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import {
	existsSync,
	mkdirSync,
	readFileSync,
	rmSync,
	statSync,
	writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { cleanupTempDirs, tempDir } from "../../tests/temp-dirs";
import { agentTools } from "../ai/tools";
import { createDecider } from "../decide/index";
import type { DecideBackend, SystemOneRequest, SystemOneResponse } from "../decide/types";
import { ToolExecutor } from "../eight/tools";
import { spawnAgentTool } from "../orchestration/delegation-tools";
import {
	ALWAYS_BLOCKED_COMMANDS,
	type PermissionManager,
	disableInfiniteMode,
	enableInfiniteMode,
	getPermissionManager,
	resetPermissionManager,
} from "./index";
import {
	INFINITE_MODE_MAX_MS,
	PERMISSION_MODES,
	PLAN_MODE_MARKER,
	type PermissionMode,
	type PermissionModeHolder,
	clampChildMode,
	claudeRuntimeRefusal,
	createChildHolder,
	createPermissionHolder,
	currentPermissionMode,
	effectivePermissionMode,
	guardedSkipsCard,
	nextPermissionMode,
	permissionRank,
	planModeRefusal,
	runWithPermissionHolder,
	setHolderMode,
	systemOneEnvFor,
} from "./permission-mode";
import {
	SYSTEM_ONE_BLOCK_MARKER,
	SYSTEM_ONE_FLAG,
	_resetSystemOne,
	_setSystemOneOverridesForTests,
} from "./system-one-gate";

// Every temp dir this file makes is removed after it (#3285).
afterAll(cleanupTempDirs);

// ── Unit ──────────────────────────────────────────────────────────────

describe("the ladder", () => {
	test("Shift+Tab cycles plan -> ask -> guarded -> infinite -> plan", () => {
		expect([...PERMISSION_MODES]).toEqual(["plan", "ask", "guarded", "infinite"]);
		const seen: PermissionMode[] = [];
		let m: PermissionMode = "ask";
		for (let i = 0; i < 5; i++) {
			m = nextPermissionMode(m);
			seen.push(m);
		}
		expect(seen).toEqual(["guarded", "infinite", "plan", "ask", "guarded"]);
	});

	const REQUESTS: Array<PermissionMode | undefined> = [undefined, ...PERMISSION_MODES];
	for (const parent of PERMISSION_MODES) {
		for (const requested of REQUESTS) {
			test(`child of ${parent} asking for ${requested ?? "nothing"} is never more permissive`, () => {
				const child = clampChildMode(parent, requested);
				expect(permissionRank(child)).toBeLessThanOrEqual(permissionRank(parent));
				const expected =
					requested === undefined
						? parent
						: permissionRank(requested) < permissionRank(parent)
							? requested
							: parent;
				expect(child).toBe(expected);
				// The linked holder answers the same, and stays under the parent.
				const holder = createChildHolder(createPermissionHolder(parent), requested);
				expect(effectivePermissionMode(holder)).toBe(expected);
			});
		}
	}

	test("narrowing a parent narrows its running child; widening it never lifts the child past its own mode", () => {
		const parent = createPermissionHolder("infinite");
		const child = createChildHolder(parent, "guarded");
		const grandchild = createChildHolder(child);
		expect(effectivePermissionMode(grandchild)).toBe("guarded");
		setHolderMode(parent, "plan");
		expect(effectivePermissionMode(child)).toBe("plan");
		expect(effectivePermissionMode(grandchild)).toBe("plan");
		setHolderMode(parent, "infinite");
		expect(effectivePermissionMode(child)).toBe("guarded");
		expect(effectivePermissionMode(grandchild)).toBe("guarded");
	});

	test("infinite expires after 30 minutes back to ask, like the process-wide flag", () => {
		const h = createPermissionHolder("infinite", undefined, 1_000);
		expect(effectivePermissionMode(h, 1_000 + INFINITE_MODE_MAX_MS)).toBe("infinite");
		expect(effectivePermissionMode(h, 1_000 + INFINITE_MODE_MAX_MS + 1)).toBe("ask");
		expect(h.mode).toBe("ask");
	});

	test("guarded turns System One on; every other mode leaves the env as it is", () => {
		const env = { PATH: "/bin" };
		expect(systemOneEnvFor("guarded", env)[SYSTEM_ONE_FLAG]).toBe("1");
		for (const m of [undefined, "plan", "ask", "infinite"] as const)
			expect(systemOneEnvFor(m, env)).toBe(env);
	});

	test("a System One allow stands in for the card only in guarded, only on a real allow, never for a dangerous command", () => {
		const allow = { run: true, guard: { verdict: "allow" } };
		expect(guardedSkipsCard("guarded", allow, false)).toBe(true);
		expect(guardedSkipsCard("guarded", allow, true)).toBe(false);
		expect(guardedSkipsCard("guarded", { run: true }, false)).toBe(false); // System One off
		expect(guardedSkipsCard("guarded", { run: true, guard: { verdict: "escalate" } }, false)).toBe(
			false,
		);
		for (const m of [undefined, "plan", "ask", "infinite"] as const)
			expect(guardedSkipsCard(m, allow, false)).toBe(false);
	});

	test("the claude runtime (permissions skipped) is refused below infinite", () => {
		for (const m of ["plan", "ask", "guarded"] as const)
			expect(claudeRuntimeRefusal(m)).toContain("never more permissive");
		expect(claudeRuntimeRefusal("infinite")).toBeNull();
		expect(claudeRuntimeRefusal(undefined)).toBeNull();
	});

	test("Plan lets reads and provably read-only shell commands through, refuses everything else", async () => {
		for (const t of [
			"read_file",
			"list_files",
			"search_symbols",
			"git_status",
			"git_diff",
			"git_log",
			"web_search",
		]) {
			expect(await planModeRefusal(t, {})).toBeNull();
		}
		for (const c of ["git status", "ls -la", "cat a.txt", "grep -rn x .", "ls 2>/dev/null"]) {
			expect(await planModeRefusal("run_command", { command: c })).toBeNull();
		}
		for (const t of [
			"write_file",
			"edit_file",
			"spawn_agent",
			"git_commit",
			"git_push",
			"background_start",
			"notebook_edit_cell",
		]) {
			expect(await planModeRefusal(t, {})).toStartWith(PLAN_MODE_MARKER);
		}
		for (const c of [
			"touch a.txt",
			"mkdir -p out",
			"printf x > a.txt",
			"ls > /tmp/list.txt",
			"bun run build",
			"rm a.txt",
		]) {
			expect(await planModeRefusal("run_command", { command: c })).toStartWith(PLAN_MODE_MARKER);
		}
	});

	test("per-call binding: concurrent calls each see their own holder, none outside", async () => {
		const a = createPermissionHolder("plan");
		const b = createPermissionHolder("infinite");
		const tick = () => new Promise((r) => setTimeout(r, 5));
		const seen = await Promise.all([
			runWithPermissionHolder(a, async () => {
				await tick();
				return currentPermissionMode();
			}),
			runWithPermissionHolder(b, async () => {
				await tick();
				return currentPermissionMode();
			}),
		]);
		expect(seen).toEqual(["plan", "infinite"]);
		expect(currentPermissionMode()).toBeUndefined();
	});
});

// ── Integration ───────────────────────────────────────────────────────

class StubBackend implements DecideBackend {
	readonly name = "stub";
	readonly model = "stub-model";
	asks: string[] = [];
	async ask(request: SystemOneRequest): Promise<SystemOneResponse> {
		this.asks.push(request.state);
		const yes = request.state.includes("-delete") ? 0.95 : 0.001;
		return {
			answers: [
				{
					id: request.questions[0].id,
					kind: "noul",
					probabilities: { yes },
					confidence: Math.max(yes, 1 - yes),
				},
			],
			backend: this.name,
			model: this.model,
			latencyMs: 0,
		};
	}
}

type PM = {
	checkPermission: (command: string) => "allowed" | "denied" | "ask";
	requestPermission: (action: string, details: string, command?: string) => Promise<boolean>;
};

const ENV_KEYS = [SYSTEM_ONE_FLAG, "EIGHT_HEADLESS", "EIGHT_DATA_DIR", "EIGHT_S1_ALLOWLIST"];
const savedEnv: Record<string, string | undefined> = {};
let dataDir: string;
let stub: StubBackend;

beforeAll(() => {
	for (const k of ENV_KEYS) savedEnv[k] = process.env[k];
	dataDir = tempDir("perm-mode-data-");
});
afterAll(() => {
	for (const k of ENV_KEYS) {
		if (savedEnv[k] === undefined) Reflect.deleteProperty(process.env, k);
		else process.env[k] = savedEnv[k];
	}
	rmSync(dataDir, { recursive: true, force: true });
	_resetSystemOne();
	resetPermissionManager();
});

/** A fresh permission manager on an empty data dir, System One stubbed, env flag off (EIGHT_SYSTEM_ONE=0). */
function freshWorld(): { dir: string; asked: string[]; humanAsked: string[] } {
	process.env[SYSTEM_ONE_FLAG] = "0";
	Reflect.deleteProperty(process.env, "EIGHT_HEADLESS");
	Reflect.deleteProperty(process.env, "EIGHT_S1_ALLOWLIST");
	process.env.EIGHT_DATA_DIR = dataDir;
	resetPermissionManager();
	disableInfiniteMode();
	stub = new StubBackend();
	const humanAsked: string[] = [];
	_setSystemOneOverridesForTests({
		createDecider: () => createDecider({ backend: stub, cacheSize: 0 }),
		askHuman: async (req) => {
			humanAsked.push(req.command);
			return false;
		},
		calibrationDir: tempDir("perm-mode-nocal-"),
	});
	return { dir: tempDir("perm-mode-"), asked: [], humanAsked };
}

/** Record approval cards on the shared manager and answer them `answer`. */
function stubCards(asked: string[], answer: boolean): () => void {
	const pm = getPermissionManager() as unknown as PM;
	const orig = pm.requestPermission;
	pm.requestPermission = async (_a, _d, command) => {
		asked.push(command ?? "");
		return answer;
	};
	return () => {
		pm.requestPermission = orig;
	};
}

function executorIn(dir: string, mode: PermissionMode | PermissionModeHolder): ToolExecutor {
	const permission = typeof mode === "string" ? createPermissionHolder(mode) : mode;
	return new ToolExecutor(dir, "perm-mode-test", undefined, { permission, openOnWrite: false });
}

const native = (name: string, input: Record<string, unknown>, dir: string, mode: PermissionMode) =>
	(
		agentTools as unknown as Record<
			string,
			{ execute: (i: unknown, o: unknown) => Promise<string> }
		>
	)[name]?.execute(input, {
		toolCallId: `t-${name}`,
		messages: [],
		experimental_context: { workingDirectory: dir, permission: createPermissionHolder(mode) },
	}) as Promise<string>;

describe("Plan refuses before anything changes, on both tool paths", () => {
	let w: ReturnType<typeof freshWorld>;
	let restore: () => void;
	beforeEach(() => {
		w = freshWorld();
		restore = stubCards(w.asked, true);
		writeFileSync(join(w.dir, "keep.txt"), "original\n");
	});
	afterEach(() => {
		restore();
		rmSync(w.dir, { recursive: true, force: true });
	});

	test("text path: write, edit, shell mutation and spawn are refused; reads run", async () => {
		const ex = executorIn(w.dir, "plan");
		expect(await ex.execute("write_file", { path: "new.txt", content: "x" })).toStartWith(
			PLAN_MODE_MARKER,
		);
		expect(
			await ex.execute("edit_file", { path: "keep.txt", oldText: "original", newText: "changed" }),
		).toStartWith(PLAN_MODE_MARKER);
		expect(await ex.execute("run_command", { command: "touch made.txt" })).toStartWith(
			PLAN_MODE_MARKER,
		);
		expect(await ex.execute("run_command", { command: "mkdir -p out" })).toStartWith(
			PLAN_MODE_MARKER,
		);
		expect(await ex.execute("spawn_agent", { task: "do things", runtime: "shell" })).toStartWith(
			PLAN_MODE_MARKER,
		);
		expect(existsSync(join(w.dir, "new.txt"))).toBe(false);
		expect(existsSync(join(w.dir, "made.txt"))).toBe(false);
		expect(existsSync(join(w.dir, "out"))).toBe(false);
		expect(readFileSync(join(w.dir, "keep.txt"), "utf-8")).toBe("original\n");
		expect(await ex.execute("read_file", { path: "keep.txt" })).toContain("original");
		expect(await ex.execute("run_command", { command: "ls" })).toContain("keep.txt");
		expect(w.asked).toEqual([]);
	});

	test("native path: write and edit are refused; reads run", async () => {
		expect(
			await native("write_file", { path: "new.txt", content: "x" }, w.dir, "plan"),
		).toStartWith(PLAN_MODE_MARKER);
		expect(
			await native(
				"edit_file",
				{ path: "keep.txt", oldText: "original", newText: "changed" },
				w.dir,
				"plan",
			),
		).toStartWith(PLAN_MODE_MARKER);
		expect(await native("run_command", { command: "touch made.txt" }, w.dir, "plan")).toStartWith(
			PLAN_MODE_MARKER,
		);
		expect(existsSync(join(w.dir, "new.txt"))).toBe(false);
		expect(existsSync(join(w.dir, "made.txt"))).toBe(false);
		expect(readFileSync(join(w.dir, "keep.txt"), "utf-8")).toBe("original\n");
		expect(await native("read_file", { path: "keep.txt" }, w.dir, "plan")).toContain("original");
		// Ask, same call: the write runs, as today.
		expect(await native("write_file", { path: "new.txt", content: "x" }, w.dir, "ask")).toContain(
			"File written",
		);
	});
});

describe("Guarded puts System One in front of Ask, with EIGHT_SYSTEM_ONE=0", () => {
	let w: ReturnType<typeof freshWorld>;
	let restore: () => void;
	beforeEach(() => {
		w = freshWorld();
		restore = stubCards(w.asked, false);
		writeFileSync(join(w.dir, "victim.txt"), "v");
		mkdirSync(join(w.dir, "build"));
	});
	afterEach(() => {
		restore();
		rmSync(w.dir, { recursive: true, force: true });
	});

	test("a command System One blocks is not run and no card is shown; in Ask the same command reaches the card", async () => {
		const guarded = await executorIn(w.dir, "guarded").execute("run_command", {
			command: "find . -name victim.txt -delete",
		});
		expect(guarded).toContain(SYSTEM_ONE_BLOCK_MARKER);
		expect(existsSync(join(w.dir, "victim.txt"))).toBe(true);
		expect(w.asked).toEqual([]);
		expect(stub.asks.length).toBe(1);

		// Ask with System One opted out: the permission layer already allows
		// `find`, so the same command runs with no card and no judge. That is
		// the gap Guarded closes (and that default-on closes in Ask too).
		await executorIn(w.dir, "ask").execute("run_command", {
			command: "find . -name victim.txt -delete",
		});
		expect(stub.asks.length).toBe(1);
		expect(w.asked).toEqual([]);
		expect(existsSync(join(w.dir, "victim.txt"))).toBe(false);
	});

	test("an allowed command that is not dangerous runs without a card (Ask would have asked)", async () => {
		const out = await executorIn(w.dir, "guarded").execute("run_command", {
			command: "printf ok > made.txt",
		});
		expect(out).not.toContain("DENIED");
		expect(w.asked).toEqual([]);
		expect(readFileSync(join(w.dir, "made.txt"), "utf-8")).toBe("ok");
		// Native path, same rule.
		const nat = await native("run_command", { command: "printf ok > made2.txt" }, w.dir, "guarded");
		expect(nat).not.toContain("DENIED");
		expect(existsSync(join(w.dir, "made2.txt"))).toBe(true);
		expect(w.asked).toEqual([]);
	});

	test("a dangerous command System One allows still gets the card", async () => {
		const before = statSync(join(w.dir, "build")).mode & 0o777;
		const out = await executorIn(w.dir, "guarded").execute("run_command", {
			command: "chmod 777 build",
		});
		expect(stub.asks.length).toBe(1); // the judge allowed it
		expect(w.asked).toEqual(["chmod 777 build"]);
		expect(out).toContain("[PERMISSION DENIED]");
		expect(statSync(join(w.dir, "build")).mode & 0o777).toBe(before);
	});
});

describe("Ask with System One on by default (EIGHT_SYSTEM_ONE unset) behaves as Ask with EIGHT_SYSTEM_ONE=1", () => {
	let w: ReturnType<typeof freshWorld>;
	let restore: () => void;
	beforeEach(() => {
		w = freshWorld();
		// Default mode asks only a calibrated judge; give the stub one.
		const cal = tempDir("perm-mode-cal-");
		writeFileSync(
			join(cal, "stub-stub-model.json"),
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
		_setSystemOneOverridesForTests({
			createDecider: () => createDecider({ backend: stub, cacheSize: 0 }),
			askHuman: async (req) => {
				w.humanAsked.push(req.command);
				return false;
			},
			calibrationDir: cal,
		});
		restore = stubCards(w.asked, false);
	});
	afterEach(() => {
		restore();
		rmSync(w.dir, { recursive: true, force: true });
	});

	async function askRun(flag: string | undefined) {
		if (flag === undefined) Reflect.deleteProperty(process.env, SYSTEM_ONE_FLAG);
		else process.env[SYSTEM_ONE_FLAG] = flag;
		const dir = tempDir("perm-mode-ask-");
		writeFileSync(join(dir, "victim.txt"), "v");
		const cardsBefore = w.asked.length;
		const del = await executorIn(dir, "ask").execute("run_command", {
			command: "find . -name victim.txt -delete",
		});
		const cardsForDelete = w.asked.length - cardsBefore;
		const made = await executorIn(dir, "ask").execute("run_command", {
			command: "printf ok > made.txt",
		});
		const out = {
			deleteBlocked: del.startsWith(SYSTEM_ONE_BLOCK_MARKER),
			victimKept: existsSync(join(dir, "victim.txt")),
			cardsForDelete,
			allowReachedCard: w.asked.at(-1) === "printf ok > made.txt",
			declinedCardDenied: made.includes("[PERMISSION DENIED]"),
		};
		rmSync(dir, { recursive: true, force: true });
		return out;
	}

	test("a block is final with no card; an allow still shows the card; same as EIGHT_SYSTEM_ONE=1", async () => {
		const byDefault = await askRun(undefined);
		expect(byDefault).toEqual({
			deleteBlocked: true,
			victimKept: true,
			cardsForDelete: 0,
			allowReachedCard: true,
			declinedCardDenied: true,
		});
		const explicit = await askRun("1");
		expect(explicit).toEqual(byDefault);
		// Opted out, the delete runs (the permission layer allows find).
		const off = await askRun("0");
		expect(off.victimKept).toBe(false);
	});
});

describe("headless (the pilot): Guarded behaves exactly like today's EIGHT_SYSTEM_ONE=1", () => {
	let w: ReturnType<typeof freshWorld>;
	beforeEach(() => {
		w = freshWorld();
		process.env.EIGHT_HEADLESS = "1";
	});
	afterEach(() => {
		Reflect.deleteProperty(process.env, "EIGHT_HEADLESS");
		Reflect.deleteProperty(process.env, SYSTEM_ONE_FLAG);
		rmSync(w.dir, { recursive: true, force: true });
	});

	const CASES = [
		"printf ok > made.txt",
		"chmod 777 build",
		"find . -name victim.txt -delete",
		"git status",
	];

	async function outcomes(run: (dir: string, command: string) => Promise<string>) {
		const out: Record<string, { ran: boolean; line: string }> = {};
		// A headless denial is remembered for the session; each side starts clean.
		resetPermissionManager();
		for (const command of CASES) {
			const dir = tempDir("perm-mode-headless-");
			writeFileSync(join(dir, "victim.txt"), "v");
			mkdirSync(join(dir, "build"));
			const before = statSync(join(dir, "build")).mode & 0o777;
			const res = await run(dir, command);
			const ran =
				existsSync(join(dir, "made.txt")) ||
				(statSync(join(dir, "build")).mode & 0o777) !== before ||
				!existsSync(join(dir, "victim.txt")) ||
				(command === "git status" && !res.startsWith("["));
			out[command] = { ran, line: res.split("\n")[0]?.slice(0, 40) ?? "" };
			rmSync(dir, { recursive: true, force: true });
		}
		return out;
	}

	test("same commands run, same commands are refused", async () => {
		const guarded = await outcomes((dir, command) =>
			new ToolExecutor(dir, "pilot", undefined, {
				permission: createPermissionHolder("guarded"),
			}).execute("run_command", {
				command,
			}),
		);
		process.env[SYSTEM_ONE_FLAG] = "1";
		const today = await outcomes((dir, command) =>
			new ToolExecutor(dir, "pilot").execute("run_command", { command }),
		);
		expect(JSON.stringify(guarded, null, 1)).toBe(JSON.stringify(today, null, 1));
		expect(today["printf ok > made.txt"]?.ran).toBe(true);
		expect(today["chmod 777 build"]?.ran).toBe(false); // dangerous, headless: denied in both
		expect(today["find . -name victim.txt -delete"]?.ran).toBe(false);
	});
});

describe("Infinite answers exactly as today's infinite flag", () => {
	let w: ReturnType<typeof freshWorld>;
	beforeEach(() => {
		w = freshWorld();
	});
	afterEach(() => {
		disableInfiniteMode();
		rmSync(w.dir, { recursive: true, force: true });
	});

	// The always-blocked list is built from its own data; these strings are only
	// ever classified, never run.
	const blocked = ALWAYS_BLOCKED_COMMANDS.map((r) => [r.command, ...r.args].join(" "));
	const commands = ["chmod 777 build", "printf ok > made.txt", "git status", "sudo ls", ...blocked];

	async function answers(pm: PermissionManager) {
		const out: Array<[string, string, boolean]> = [];
		for (const c of commands)
			out.push([c, pm.checkPermission(c), await pm.requestPermission("x", "y", c)]);
		return out;
	}

	test("checkPermission and requestPermission agree command for command, blocks included", async () => {
		const pm = getPermissionManager();
		enableInfiniteMode();
		const flag = await answers(pm);
		disableInfiniteMode();
		const mode = await runWithPermissionHolder(createPermissionHolder("infinite"), () =>
			answers(pm),
		);
		expect(mode).toEqual(flag);
		for (const c of blocked) expect(mode.find(([x]) => x === c)?.[1]).toBe("denied");
		expect(mode.find(([x]) => x === "chmod 777 build")?.[1]).toBe("allowed");
	});

	test("a call in any other mode is not infinite, even with the flag on; no mode bound follows the flag", async () => {
		const pm = getPermissionManager();
		enableInfiniteMode();
		for (const m of ["plan", "ask", "guarded"] as const) {
			expect(runWithPermissionHolder(createPermissionHolder(m), () => pm.isInfiniteMode())).toBe(
				false,
			);
		}
		expect(pm.isInfiniteMode()).toBe(true);
		disableInfiniteMode();
		expect(
			runWithPermissionHolder(createPermissionHolder("infinite"), () => pm.isInfiniteMode()),
		).toBe(true);
		expect(pm.isInfiniteMode()).toBe(false);
	});
});

describe("per tab: one agent's mode never reaches another's", () => {
	let w: ReturnType<typeof freshWorld>;
	let restore: () => void;
	beforeEach(() => {
		w = freshWorld();
		restore = stubCards(w.asked, true);
		mkdirSync(join(w.dir, "a"));
		mkdirSync(join(w.dir, "b"));
	});
	afterEach(() => {
		restore();
		rmSync(w.dir, { recursive: true, force: true });
	});

	test("two agents in one process, run at the same time: only the Ask one shows a card", async () => {
		const tabA = createPermissionHolder("infinite");
		const tabB = createPermissionHolder("ask");
		const a = executorIn(join(w.dir, "a"), tabA);
		const b = executorIn(join(w.dir, "b"), tabB);
		await Promise.all([
			a.execute("run_command", { command: "printf a > a.txt" }),
			b.execute("run_command", { command: "printf b > b.txt" }),
		]);
		expect(w.asked).toEqual(["printf b > b.txt"]);

		// Tab A goes to Plan: B is untouched and still asks, A now refuses.
		setHolderMode(tabA, "plan");
		expect(await a.execute("run_command", { command: "printf a > a2.txt" })).toStartWith(
			PLAN_MODE_MARKER,
		);
		await b.execute("run_command", { command: "printf b > b2.txt" });
		expect(w.asked).toEqual(["printf b > b.txt", "printf b > b2.txt"]);
		expect(existsSync(join(w.dir, "a", "a2.txt"))).toBe(false);
		expect(existsSync(join(w.dir, "b", "b2.txt"))).toBe(true);
	});
});

describe("spawn: a child is never more permissive than its parent", () => {
	let w: ReturnType<typeof freshWorld>;
	let restore: () => void;
	let captured: Array<Record<string, unknown>>;
	let origSpawn: unknown;
	let pool: { spawnAgent: (task: string, cfg: Record<string, unknown>) => Promise<unknown> };
	beforeEach(async () => {
		w = freshWorld();
		restore = stubCards(w.asked, false);
		captured = [];
		const { getAgentPool } = await import("../orchestration/index");
		pool = getAgentPool() as unknown as typeof pool;
		origSpawn = pool.spawnAgent;
		pool.spawnAgent = async (_task, cfg) => {
			captured.push(cfg);
			return { id: `agent-${captured.length}`, status: "running" };
		};
	});
	afterEach(() => {
		pool.spawnAgent = origSpawn as typeof pool.spawnAgent;
		restore();
		rmSync(w.dir, { recursive: true, force: true });
	});

	const REQUESTS: Array<PermissionMode | undefined> = [undefined, ...PERMISSION_MODES];
	for (const parent of ["ask", "guarded", "infinite"] as const) {
		test(`8gent runtime under ${parent}: every requested mode is clamped, and the child stays linked`, async () => {
			const parentHolder = createPermissionHolder(parent);
			for (const requested of REQUESTS) {
				const out = await runWithPermissionHolder(parentHolder, () =>
					spawnAgentTool(w.dir, "task", "8gent", undefined, undefined, undefined, requested),
				);
				const child = captured.at(-1)?.permission as PermissionModeHolder;
				expect(effectivePermissionMode(child)).toBe(clampChildMode(parent, requested));
				expect(JSON.parse(out).permissionMode).toBe(clampChildMode(parent, requested));
			}
			setHolderMode(parentHolder, "plan");
			for (const cfg of captured)
				expect(effectivePermissionMode(cfg.permission as PermissionModeHolder)).toBe("plan");
		});
	}

	test("a Plan parent spawns nothing, whatever runtime or mode it asks for", async () => {
		for (const runtime of ["8gent", "shell", "claude"] as const) {
			const out = await runWithPermissionHolder(createPermissionHolder("plan"), () =>
				spawnAgentTool(w.dir, "touch x.txt", runtime, undefined, undefined, undefined, "infinite"),
			);
			expect(out).toStartWith(PLAN_MODE_MARKER);
		}
		expect(captured).toEqual([]);
	});

	test("the claude runtime (permissions skipped) is refused under ask and guarded, even when infinite is asked for", async () => {
		for (const parent of ["ask", "guarded"] as const) {
			const out = await runWithPermissionHolder(createPermissionHolder(parent), () =>
				spawnAgentTool(w.dir, "task", "claude", undefined, undefined, undefined, "infinite"),
			);
			expect(out).toContain("never more permissive");
		}
	});

	test("a shell child under Ask goes through the card like run_command, and does not run when declined", async () => {
		const out = await runWithPermissionHolder(createPermissionHolder("ask"), () =>
			spawnAgentTool(w.dir, "printf s > shell-child.txt", "shell"),
		);
		expect(w.asked).toEqual(["printf s > shell-child.txt"]);
		expect(out).toContain("[PERMISSION DENIED]");
		expect(existsSync(join(w.dir, "shell-child.txt"))).toBe(false);
	});

	test("no mode bound and none asked for: the spawn carries no mode, as before", async () => {
		await spawnAgentTool(w.dir, "task", "8gent");
		expect(captured.at(-1)?.permission).toBeUndefined();
		// Asking for a mode with none bound clamps to the process: ask unless the flag is on.
		await spawnAgentTool(w.dir, "task", "8gent", undefined, undefined, undefined, "infinite");
		expect(effectivePermissionMode(captured.at(-1)?.permission as PermissionModeHolder)).toBe(
			"ask",
		);
	});
});
