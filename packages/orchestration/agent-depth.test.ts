/**
 * spawn_agent has a hard recursion cap (#3331, 8SO ruling msg 3552).
 *
 * The user's own agent is depth 0. Each spawn makes a child one deeper, and a
 * child deeper than MAX_AGENT_DEPTH (3) is refused at dispatch with a tool
 * error: no pool entry, no process. The depth rides an AsyncLocalStorage the
 * agent pool binds around each child's run, so a child's tool calls see their
 * own depth and nothing the child passes or sets can lower it.
 *
 * These tests use the real spawnAgentTool and the real AgentPool. Only the
 * child's model loop is replaced: instead of chatting with a model, each child
 * calls spawn_agent itself, from inside the context the pool bound for it.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnAgentTool } from "./delegation-tools";
import {
	AGENT_DEPTH_EXIT_CODE,
	AgentDepthError,
	type AgentPool,
	MAX_AGENT_DEPTH,
	childAgentEnv,
	currentAgentDepth,
	getAgentPool,
	getCLIAgentStatus,
	listCLIAgents,
	processAgentDepth,
	processAgentDepthRefusal,
	resetOrchestration,
	runAtAgentDepth,
} from "./index";

type Run = (agentId: string) => Promise<void>;

let dir: string;
let pool: AgentPool;

beforeEach(() => {
	dir = mkdtempSync(join(tmpdir(), "agent-depth-"));
	resetOrchestration();
	pool = getAgentPool(10);
});

afterEach(() => {
	resetOrchestration();
	rmSync(dir, { recursive: true, force: true });
});

/** Replace the child's model loop: run `body` as the child, in its bound context. */
function childLoop(body: (agentId: string) => Promise<void>): void {
	(pool as unknown as { runAgent: Run }).runAgent = body;
}

/** Each child calls spawn_agent again, as a runaway model would. Resolves when the chain stops. */
async function recurse(): Promise<{ depths: number[]; results: string[] }> {
	const depths: number[] = [];
	const results: string[] = [];
	let done!: () => void;
	const finished = new Promise<void>((r) => {
		done = r;
	});
	childLoop(async () => {
		depths.push(currentAgentDepth());
		const out = await spawnAgentTool(dir, "spawn another agent", "8gent", "probe:1b");
		results.push(out);
		if (!out.startsWith("{")) done();
	});
	results.push(await spawnAgentTool(dir, "spawn an agent", "8gent", "probe:1b"));
	await finished;
	return { depths, results };
}

describe("MAX_AGENT_DEPTH (#3331)", () => {
	test("the cap is 3 and the user's agent is depth 0", () => {
		expect(MAX_AGENT_DEPTH).toBe(3);
		expect(currentAgentDepth()).toBe(0);
	});

	test("depths 1, 2 and 3 spawn; the depth-3 agent's spawn is refused with a tool error and starts nothing", async () => {
		const { depths, results } = await recurse();
		expect(depths).toEqual([1, 2, 3]);
		expect(pool.listAgents().map((a) => a.config.depth)).toEqual([1, 2, 3]);
		expect(results).toHaveLength(4);
		const refused = results.filter((r) => !r.startsWith("{"));
		expect(refused).toHaveLength(1);
		expect(refused[0]).toStartWith("[AGENT DEPTH BLOCKED]");
		expect(refused[0]).toContain("MAX_AGENT_DEPTH is 3");
		expect(refused[0]).toContain("depth 3");
		for (const ok of results.filter((r) => r.startsWith("{")))
			expect(JSON.parse(ok).agentId).toStartWith("agent-");
		expect(pool.listAgents()).toHaveLength(3);
	});

	test("a refused spawn starts no process on the claude or shell runtimes either", async () => {
		const before = listCLIAgents().length;
		for (const runtime of ["claude", "shell", "8gent"] as const) {
			const out = await runAtAgentDepth(3, () => spawnAgentTool(dir, "true", runtime));
			expect(out).toStartWith("[AGENT DEPTH BLOCKED]");
		}
		expect(listCLIAgents().length).toBe(before);
		expect(pool.listAgents()).toHaveLength(0);
	});

	test("a forked child inherits its parent's depth + 1, whoever runs it later", async () => {
		const seen: number[] = [];
		childLoop(async () => {
			seen.push(currentAgentDepth());
		});
		await runAtAgentDepth(1, () => spawnAgentTool(dir, "child of a depth-1 agent", "8gent"));
		expect(pool.listAgents().map((a) => a.config.depth)).toEqual([2]);
		expect(seen).toEqual([2]);
		// A queued child keeps its own depth even when a sibling at another depth
		// is the one whose finish starts it.
		resetOrchestration();
		pool = getAgentPool(1);
		const ran: Array<[string, number]> = [];
		let release!: () => void;
		const gate = new Promise<void>((r) => {
			release = r;
		});
		childLoop(async (id) => {
			ran.push([id, currentAgentDepth()]);
			if (ran.length === 1) await gate;
		});
		const first = JSON.parse(await runAtAgentDepth(2, () => spawnAgentTool(dir, "a", "8gent")));
		const queued = JSON.parse(await spawnAgentTool(dir, "b", "8gent"));
		expect(pool.getAgent(queued.agentId)?.status).toBe("idle");
		release();
		for (let i = 0; i < 100 && ran.length < 2; i++) await Bun.sleep(5);
		expect(ran).toEqual([
			[first.agentId, 3],
			[queued.agentId, 1],
		]);
	});

	test("the child cannot reset its depth", async () => {
		const results: string[] = [];
		childLoop(async () => {
			// Everything a child could try: ask the pool for depth 0 directly,
			// rebind a shallower depth, and set the env var a process child reads.
			// (spawn_agent itself takes no depth argument, so a model cannot pass one.)
			process.env.EIGHT_AGENT_DEPTH = "0";
			await pool.spawnAgent("direct", { depth: 0 } as never).then(
				(a) => results.push(`spawned ${a.config.depth}`),
				(e: Error) => results.push(e.message),
			);
			results.push(await runAtAgentDepth(0, () => spawnAgentTool(dir, "rebind", "8gent")));
			results.push(await spawnAgentTool(dir, "after env reset", "8gent"));
		});
		try {
			await runAtAgentDepth(2, () => spawnAgentTool(dir, "make a depth-3 child", "8gent"));
			for (let i = 0; i < 100 && results.length < 3; i++) await Bun.sleep(5);
		} finally {
			delete process.env.EIGHT_AGENT_DEPTH;
		}
		expect(results).toHaveLength(3);
		expect(results[0]).toContain("MAX_AGENT_DEPTH is 3");
		expect(results[1]).toStartWith("[AGENT DEPTH BLOCKED]");
		expect(results[2]).toStartWith("[AGENT DEPTH BLOCKED]");
		expect(pool.listAgents().map((a) => a.config.depth)).toEqual([3]);
	});

	test("EIGHT_AGENT_DEPTH is parsed fail-closed at load: unreadable means MAX, refused", () => {
		// The value is read once at module load, so each case needs a fresh process.
		const indexPath = join(import.meta.dir, "index.ts");
		const script = `const m = await import(${JSON.stringify(indexPath)}); console.log(JSON.stringify({ depth: m.currentAgentDepth(), refused: m.agentDepthRefusal() !== null }));`;
		const cases: Array<[string | undefined, number]> = [
			[undefined, 0],
			["", 0],
			["2", 2],
			["abc", MAX_AGENT_DEPTH],
			["-1", MAX_AGENT_DEPTH],
			["3.5", MAX_AGENT_DEPTH],
			["1e309", MAX_AGENT_DEPTH],
			["0x3", MAX_AGENT_DEPTH],
			[" 3 ", 3],
		];
		for (const [value, expected] of cases) {
			const { EIGHT_AGENT_DEPTH: _inherited, ...rest } = process.env;
			const env = { ...rest, ...(value === undefined ? {} : { EIGHT_AGENT_DEPTH: value }) };
			const proc = Bun.spawnSync([process.execPath, "-e", script], {
				env,
				stdout: "pipe",
				stderr: "pipe",
			});
			const line = proc.stdout.toString().trim().split("\n").pop() ?? "";
			const got = JSON.parse(line) as { depth: number; refused: boolean };
			expect({ value, ...got }).toEqual({
				value,
				depth: expected,
				refused: expected >= MAX_AGENT_DEPTH,
			});
		}
	});

	// POSIX only: the child echoes $EIGHT_AGENT_DEPTH, which only a POSIX shell expands.
	test.skipIf(process.platform === "win32")(
		"a process child (claude or shell runtime) is told its depth through EIGHT_AGENT_DEPTH",
		async () => {
			const saved = process.env.EIGHT_SYSTEM_ONE;
			process.env.EIGHT_SYSTEM_ONE = "off";
			const out = JSON.parse(
				await runAtAgentDepth(2, () =>
					spawnAgentTool(dir, 'printf "%s" "$EIGHT_AGENT_DEPTH"', "shell"),
				),
			) as { agentId: string };
			if (saved === undefined) delete process.env.EIGHT_SYSTEM_ONE;
			else process.env.EIGHT_SYSTEM_ONE = saved;
			let status = getCLIAgentStatus(out.agentId);
			for (let i = 0; i < 200 && !status?.result; i++) {
				await Bun.sleep(10);
				status = getCLIAgentStatus(out.agentId);
			}
			expect(status?.result?.stdout).toBe("3");
		},
	);
});

/** Run `script` in a fresh bun process whose inherited EIGHT_AGENT_DEPTH is replaced by `value`. */
function inFreshProcess(value: string | undefined, script: string): string {
	const { EIGHT_AGENT_DEPTH: _inherited, ...rest } = process.env;
	const env = { ...rest, ...(value === undefined ? {} : { EIGHT_AGENT_DEPTH: value }) };
	const proc = Bun.spawnSync([process.execPath, "-e", script], {
		env,
		stdout: "pipe",
		stderr: "pipe",
	});
	return proc.stdout.toString().trim().split("\n").pop() ?? "";
}

const INDEX = JSON.stringify(join(import.meta.dir, "index.ts"));

describe("childAgentEnv and the process refusal (#3341)", () => {
	test("a process an agent starts is one deeper than the agent", () => {
		expect(childAgentEnv()).toEqual({ EIGHT_AGENT_DEPTH: "1" });
		expect(runAtAgentDepth(2, () => childAgentEnv())).toEqual({ EIGHT_AGENT_DEPTH: "3" });
		expect(runAtAgentDepth(3, () => childAgentEnv())).toEqual({ EIGHT_AGENT_DEPTH: "4" });
	});

	test("nothing the agent writes to the env lowers its child's depth", () => {
		try {
			process.env.EIGHT_AGENT_DEPTH = "0";
			const env = runAtAgentDepth(2, () => ({
				...process.env,
				...{ EIGHT_AGENT_DEPTH: "0" },
				...childAgentEnv(),
			}));
			expect(env.EIGHT_AGENT_DEPTH).toBe("3");
		} finally {
			delete process.env.EIGHT_AGENT_DEPTH;
		}
	});

	test("the process's inherited depth carries into its children", () => {
		const got = JSON.parse(
			inFreshProcess(
				"2",
				`const m = await import(${INDEX}); console.log(JSON.stringify({ depth: m.processAgentDepth(), child: m.childAgentEnv() }));`,
			),
		);
		expect(got).toEqual({ depth: 2, child: { EIGHT_AGENT_DEPTH: "3" } });
		expect(processAgentDepth()).toBe(0);
	});

	test("a fail-closed parent (unreadable EIGHT_AGENT_DEPTH) gives its child 4, which is refused", () => {
		const got = JSON.parse(
			inFreshProcess(
				"abc",
				`const m = await import(${INDEX}); console.log(JSON.stringify({ depth: m.processAgentDepth(), child: m.childAgentEnv() }));`,
			),
		);
		expect(got).toEqual({ depth: MAX_AGENT_DEPTH, child: { EIGHT_AGENT_DEPTH: "4" } });
		const child = JSON.parse(
			inFreshProcess(
				got.child.EIGHT_AGENT_DEPTH,
				`const m = await import(${INDEX}); console.log(JSON.stringify({ refused: m.processAgentDepthRefusal() !== null }));`,
			),
		);
		expect(child).toEqual({ refused: true });
	});

	test("a depth that is not a safe non-negative integer gives the child MAX + 1, never a value it would read as MAX", () => {
		// The child parses NaN, Infinity or anything past 2^53 as MAX (3) and would
		// run a model loop. Emitting MAX + 1 makes the child refuse instead.
		for (const depth of [Number.NaN, Number.POSITIVE_INFINITY, Number.MAX_SAFE_INTEGER, 2 ** 60]) {
			expect({ depth, env: runAtAgentDepth(depth, () => childAgentEnv()) }).toEqual({
				depth,
				env: { EIGHT_AGENT_DEPTH: String(MAX_AGENT_DEPTH + 1) },
			});
		}
	});

	test("a process deeper than MAX_AGENT_DEPTH is refused; up to MAX it runs", () => {
		const script = `const m = await import(${INDEX}); console.log(JSON.stringify({ depth: m.processAgentDepth(), refusal: m.processAgentDepthRefusal() }));`;
		const cases: Array<[string | undefined, number, boolean]> = [
			[undefined, 0, false],
			["0", 0, false],
			["3", 3, false],
			["4", 4, true],
			["99", 99, true],
			// #3331 parses an unreadable value as MAX: the process runs but cannot spawn.
			["abc", MAX_AGENT_DEPTH, false],
		];
		for (const [value, depth, refused] of cases) {
			const got = JSON.parse(inFreshProcess(value, script)) as {
				depth: number;
				refusal: string | null;
			};
			expect({ value, depth: got.depth, refused: got.refusal !== null }).toEqual({
				value,
				depth,
				refused,
			});
			if (refused) {
				expect(got.refusal).toStartWith("[AGENT DEPTH BLOCKED]");
				expect(got.refusal).toContain(`EIGHT_AGENT_DEPTH=${value}`);
				expect(got.refusal).toContain("MAX_AGENT_DEPTH is 3");
			}
		}
		expect(processAgentDepthRefusal()).toBeNull();
	});

	test("the refusal has its own error class and exit code", () => {
		const e = new AgentDepthError("[AGENT DEPTH BLOCKED] x");
		expect(e).toBeInstanceOf(Error);
		expect(e).toBeInstanceOf(AgentDepthError);
		expect(e.name).toBe("AgentDepthError");
		expect(e.message).toBe("[AGENT DEPTH BLOCKED] x");
		expect(AGENT_DEPTH_EXIT_CODE).toBe(77);
	});

	test("a bun test started by an agent does not inherit the agent's depth (R1)", async () => {
		const root = join(import.meta.dir, "..", "..");
		const probeDir = mkdtempSync(join(tmpdir(), "depth-probe-"));
		const probe = join(probeDir, "probe.test.ts");
		await Bun.write(
			probe,
			`import { test } from "bun:test"; test("probe", async () => { const m = await import(${INDEX}); console.log("PROBE " + JSON.stringify({ env: process.env.EIGHT_AGENT_DEPTH ?? null, depth: m.currentAgentDepth() })); });`,
		);
		try {
			const proc = Bun.spawnSync([process.execPath, "test", probe], {
				cwd: root,
				env: { ...process.env, EIGHT_AGENT_DEPTH: "4" },
				stdout: "pipe",
				stderr: "pipe",
			});
			const out = proc.stdout.toString() + proc.stderr.toString();
			const line = out.split("\n").find((l) => l.startsWith("PROBE ")) ?? "";
			expect(line).not.toBe("");
			expect(JSON.parse(line.slice(6))).toEqual({ env: null, depth: 0 });
			expect(proc.exitCode).toBe(0);
		} finally {
			rmSync(probeDir, { recursive: true, force: true });
		}
	});
});
