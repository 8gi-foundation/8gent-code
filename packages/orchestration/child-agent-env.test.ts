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
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
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

/**
 * Run argv in a fresh bun process whose inherited EIGHT_AGENT_DEPTH is replaced
 * by `depth`. `extra` overrides the env last (HOME, OLLAMA_HOST).
 */
function fresh(depth: string | undefined, argv: string[], extra: Record<string, string> = {}): Run {
	const { EIGHT_AGENT_DEPTH: _inherited, ...rest } = process.env;
	const env = {
		...rest,
		HOME: home,
		NO_COLOR: "1",
		...(depth === undefined ? {} : { EIGHT_AGENT_DEPTH: depth }),
		...extra,
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
			// So does --continue <id>, the other rewrite into a TUI launch.
			["outline --continue <id>", ["outline", "x.ts", "--continue", "abc"]],
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

describe("~/.8gent/keys.env cannot set the depth (#3341, 8SO finding A)", () => {
	// keys.env fills any env var that is unset, with no allowlist. The depth is
	// parsed once, when the bin statically imports orchestration/agent-depth.ts,
	// which is before main() loads keys. So a stray EIGHT_AGENT_DEPTH line there
	// must decide nothing: every outcome matches a session with no keys file.
	let keysHome: string;
	// Nothing listens on port 9 (discard), so `run` fails fast at the model call
	// and never needs a real one.
	const NO_MODEL = { OLLAMA_HOST: "http://127.0.0.1:9" };
	const RUN = ["run", "--provider", "ollama", "--model", "depth-probe", "x"];

	beforeAll(() => {
		keysHome = mkdtempSync(join(tmpdir(), "child-agent-env-keys-"));
		mkdirSync(join(keysHome, ".8gent"));
		writeFileSync(join(keysHome, ".8gent", "keys.env"), "EIGHT_AGENT_DEPTH=4\n");
	});

	afterAll(() => {
		rmSync(keysHome, { recursive: true, force: true });
	});

	test("the throwaway keys.env really carries EIGHT_AGENT_DEPTH=4", () => {
		expect(readFileSync(join(keysHome, ".8gent", "keys.env"), "utf8")).toContain(
			"EIGHT_AGENT_DEPTH=4",
		);
	});

	test("run, --cli and --version with EIGHT_AGENT_DEPTH=4 only in keys.env behave as unset", () => {
		const cases: Array<[string, string[]]> = [
			["run", RUN],
			["--cli", ["--cli"]],
			["--version", ["--version"]],
		];
		for (const [label, args] of cases) {
			const unset = fresh(undefined, [BIN, ...args], NO_MODEL);
			const keyed = fresh(undefined, [BIN, ...args], { ...NO_MODEL, HOME: keysHome });
			expectNotRefused(keyed);
			expect({ label, code: keyed.code }).toEqual({ label, code: unset.code });
		}
	});

	test("run with a keys.env depth gets past the Agent backstop to the model call", () => {
		const keyed = fresh(undefined, [BIN, ...RUN], { ...NO_MODEL, HOME: keysHome });
		expectNotRefused(keyed);
		expect(keyed.stdout + keyed.stderr).toContain("127.0.0.1:9");
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

	test("`run` maps the backstop's AgentDepthError to exit 77, not 1 (8SO finding B)", () => {
		// Called directly, past the bin gate: the one path where run.ts itself
		// sees the refusal. Port 9 has no model, so a run that got past the
		// backstop would fail at the model call instead.
		const RUN = JSON.stringify(join(ROOT, "packages", "eight", "run.ts"));
		for (const format of [[], ["--output-format", "stream-json"]]) {
			const argv = JSON.stringify(["--provider", "ollama", "--model", "p", ...format, "x"]);
			const run = fresh(
				"4",
				[
					"-e",
					`const { runRunCommand } = await import(${RUN}); process.exit(await runRunCommand(${argv}));`,
				],
				{ OLLAMA_HOST: "http://127.0.0.1:9" },
			);
			expect({ format, code: run.code }).toEqual({ format, code: AGENT_DEPTH_EXIT_CODE });
			expect(run.stdout + run.stderr).toContain("[AGENT DEPTH BLOCKED]");
			expect(run.stdout + run.stderr).not.toContain("127.0.0.1:9");
		}
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
