/**
 * A process past MAX_AGENT_DEPTH does not start a model loop (#3341, PR2).
 *
 * EIGHT_AGENT_DEPTH is read once at load, so every case here runs in a fresh
 * process with the inherited value replaced by the one under test. The bin
 * cases run the real entrypoint, bin/8gent.ts, the source of the shipped
 * dist/cli.js. No model is reachable and none is needed: a refusal happens
 * before anything that would contact one.
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Agent } from "../eight/agent";
import {
	AGENT_DEPTH_EXIT_CODE,
	MAX_AGENT_DEPTH,
	processAgentDepth,
	runAtAgentDepth,
} from "./index";

const ROOT = join(import.meta.dir, "..", "..");
const BIN = join(ROOT, "bin", "8gent.ts");
const AGENT = JSON.stringify(join(ROOT, "packages", "eight", "agent.ts"));

let home: string;
let fixtureDir: string;
let fixture: string;

beforeAll(() => {
	home = mkdtempSync(join(tmpdir(), "child-agent-env-home-"));
	fixtureDir = mkdtempSync(join(tmpdir(), "child-agent-env-fixture-"));
	fixture = join(fixtureDir, "fixture.ts");
	writeFileSync(fixture, "export function depthFixture(a: number): number {\n\treturn a + 1;\n}\n");
});

afterAll(() => {
	rmSync(home, { recursive: true, force: true });
	rmSync(fixtureDir, { recursive: true, force: true });
});

type Run = { code: number | null; stdout: string; stderr: string; ms: number };

/** Run argv in a fresh bun process whose inherited EIGHT_AGENT_DEPTH is replaced by `depth`. */
function fresh(depth: string | undefined, argv: string[]): Run {
	const { EIGHT_AGENT_DEPTH: _inherited, ...rest } = process.env;
	const env = {
		...rest,
		HOME: home,
		NO_COLOR: "1",
		...(depth === undefined ? {} : { EIGHT_AGENT_DEPTH: depth }),
	};
	const start = performance.now();
	const proc = Bun.spawnSync([process.execPath, ...argv], {
		cwd: ROOT,
		env,
		stdin: "ignore",
		stdout: "pipe",
		stderr: "pipe",
		timeout: 30_000,
	});
	return {
		code: proc.exitCode,
		stdout: proc.stdout.toString(),
		stderr: proc.stderr.toString(),
		ms: performance.now() - start,
	};
}

function expectRefused(run: Run, label: string): void {
	expect({ label, code: run.code }).toEqual({ label, code: AGENT_DEPTH_EXIT_CODE });
	expect(run.stderr).toContain("[AGENT DEPTH BLOCKED]");
	expect(run.stderr).toContain(`MAX_AGENT_DEPTH is ${MAX_AGENT_DEPTH}`);
	expect(run.stderr).toContain("EIGHT_AGENT_DEPTH=4");
	expect(run.stdout).toBe("");
}

function expectNotRefused(run: Run): void {
	expect(run.code).not.toBe(AGENT_DEPTH_EXIT_CODE);
	expect(run.stderr).not.toContain("[AGENT DEPTH BLOCKED]");
	expect(run.stdout).not.toContain("[AGENT DEPTH BLOCKED]");
}

describe("bin/8gent.ts refuses to start past MAX_AGENT_DEPTH (#3341)", () => {
	test("--cli at depth 4 exits 77 with the refusal, before any provider is contacted", () => {
		const run = fresh("4", [BIN, "--cli", "hi"]);
		expectRefused(run, "--cli");
		// Nothing listens for a model here; a refusal that reached a provider
		// would hang on retries or fail with a provider error, not exit 77 fast.
		expect(run.ms).toBeLessThan(5_000);
	});

	test("the plain start (TUI), --rpc, run, tui and chat at depth 4 each exit 77", () => {
		const cases: Array<[string, string[]]> = [
			["plain start", []],
			["--rpc", ["--rpc"]],
			["run", ["run", "x"]],
			["tui", ["tui"]],
			["chat", ["chat"]],
			["implicit tui flag", ["--provider=ollama"]],
		];
		for (const [label, args] of cases) expectRefused(fresh("4", [BIN, ...args]), label);
	});

	test("anything not on the allowlist is refused at depth 4, unknown commands included (deny by default)", () => {
		const cases: Array<[string, string[]]> = [
			["init", ["init"]],
			["memory", ["memory", "stats"]],
			["unknown", ["frobnicate"]],
			// An allowlisted flag does not exempt a model-loop mode checked before it.
			["--cli --version", ["--cli", "--version"]],
			// --resume rewrites any command into a TUI launch, so it is not exempt.
			["outline --resume", ["outline", "x.ts", "--resume"]],
		];
		for (const [label, args] of cases) expectRefused(fresh("4", [BIN, ...args]), label);
	});

	test("each allowlisted command still works at depth 4", () => {
		for (const flag of ["--version", "-v"]) {
			const run = fresh("4", [BIN, flag]);
			expectNotRefused(run);
			expect(run.code).toBe(0);
			expect(run.stdout).toContain("8gent Code v");
		}
		for (const flag of ["--help", "-h"]) {
			const run = fresh("4", [BIN, flag]);
			expectNotRefused(run);
			expect(run.code).toBe(0);
			expect(run.stdout.length).toBeGreaterThan(0);
		}
		const outline = fresh("4", [BIN, "outline", fixture, "--json"]);
		expectNotRefused(outline);
		expect(outline.code).toBe(0);
		expect(outline.stdout).toContain("depthFixture");

		const symbol = fresh("4", [BIN, "symbol", `${fixture}::depthFixture`]);
		expectNotRefused(symbol);
		expect(symbol.code).toBe(0);
		expect(symbol.stdout).toContain("return a + 1");

		const search = fresh("4", [BIN, "search", "depthFixture", `--dir=${fixtureDir}`]);
		expectNotRefused(search);
		expect(search.code).toBe(0);
		expect(search.stdout).toContain("depthFixture");

		const doctor = fresh("4", [BIN, "doctor"]);
		expectNotRefused(doctor);
		expect(doctor.code).toBe(0);
		expect(doctor.stdout).toContain("8gent Doctor");
	});

	test("at depth 3 and unset the gate is open: the boundary is greater than MAX, not at MAX", () => {
		for (const depth of ["3", undefined]) {
			const version = fresh(depth, [BIN, "--version"]);
			expectNotRefused(version);
			expect(version.code).toBe(0);
		}
		// --cli gets past the gate to runCLI, which stops on the empty prompt
		// (stdin is /dev/null) without contacting a model. "abc" is the #3331
		// fail-closed parse: MAX, so it runs (and cannot spawn).
		for (const depth of ["3", "abc", "", undefined]) {
			const cli = fresh(depth, [BIN, "--cli"]);
			expectNotRefused(cli);
			expect({ depth, code: cli.code }).toEqual({ depth, code: 1 });
			expect(cli.stderr).toContain("No prompt provided");
		}
	});

	test("the bin reads the value through the same parse as the library: padded 4 is refused", () => {
		expectRefused(fresh(" 4 ", [BIN, "--cli", "hi"]), "padded 4");
	});
});

describe("Agent constructor backstop (#3341)", () => {
	const script = `
		const { Agent } = await import(${AGENT});
		try {
			new Agent({ model: "eight-1.0-q3:14b", runtime: "ollama" });
			console.log(JSON.stringify({ constructed: true }));
		} catch (e) {
			console.log(JSON.stringify({ constructed: false, name: e.name, message: e.message }));
		}
		process.exit(0);
	`;

	function construct(depth: string): { constructed: boolean; name?: string; message?: string } {
		const run = fresh(depth, ["-e", script]);
		const line = run.stdout.trim().split("\n").pop() ?? "";
		return JSON.parse(line);
	}

	test("a process at depth 4 cannot construct an Agent: AgentDepthError", () => {
		const got = construct("4");
		expect(got.constructed).toBe(false);
		expect(got.name).toBe("AgentDepthError");
		expect(got.message).toStartWith("[AGENT DEPTH BLOCKED]");
		expect(got.message).toContain("MAX_AGENT_DEPTH is 3");
	});

	test("a process at depth 3 constructs an Agent", () => {
		expect(construct("3")).toEqual({ constructed: true });
	});

	test("an in-process pool child at depth 3 constructs: the backstop reads process depth, not the call's depth", () => {
		expect(processAgentDepth()).toBe(0);
		const agent = runAtAgentDepth(
			MAX_AGENT_DEPTH,
			() => new Agent({ model: "eight-1.0-q3:14b", runtime: "ollama" }),
		);
		expect(agent).toBeInstanceOf(Agent);
	});
});
