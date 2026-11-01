import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { EFFORT_BY_TASK_KIND, applyEffortPolicy } from "../providers/effort-policy";
import { ProviderManager } from "../providers/index";
import { CLI_TASK_KINDS, buildCLIChatRequest, buildCLIResult, parseCLIArgs } from "./cli";

const ON = { EIGHT_EFFORT_POLICY: "1" };

/** Runs bin/8gent.ts in a child with a temp HOME and data dir and no API keys. */
function spawnCli(args: string[]): { exitCode: number; stdout: string; stderr: string } {
	const home = fs.mkdtempSync(path.join(os.tmpdir(), "cli-task-kind-"));
	try {
		const bin = path.join(import.meta.dir, "..", "..", "bin", "8gent.ts");
		const env: Record<string, string | undefined> = {
			...process.env,
			HOME: home,
			TMPDIR: home,
			EIGHT_HOME: path.join(home, ".8gent"),
			EIGHT_DATA_DIR: path.join(home, ".8gent"),
		};
		delete env.OPENAI_API_KEY;
		delete env.ANTHROPIC_API_KEY;
		const proc = Bun.spawnSync([process.execPath, bin, ...args], { env });
		return {
			exitCode: proc.exitCode ?? -1,
			stdout: proc.stdout.toString(),
			stderr: proc.stderr.toString(),
		};
	} finally {
		fs.rmSync(home, { recursive: true, force: true });
	}
}

describe("--cli --task-kind", () => {
	test("each accepted kind reaches applyEffortPolicy and sets thinking when the flag is on", () => {
		const expected: Record<string, string> = {
			simple: "low",
			code: "medium",
			reasoning: "high",
			review: "high",
		};
		for (const kind of CLI_TASK_KINDS) {
			const opts = parseCLIArgs(["--cli", "--task-kind", kind, "hello"]);
			expect(opts?.taskKind).toBe(kind);
			expect(opts?.taskKindError).toBeUndefined();
			const req = buildCLIChatRequest(opts!);
			expect(req.taskKind).toBe(kind);
			expect(applyEffortPolicy(req, ON).thinking).toBe(expected[kind] as never);
		}
	});

	test("--task-kind=<kind> form works and is not taken as prompt text", () => {
		const opts = parseCLIArgs(["--cli", "--task-kind=review", "find", "the", "bug"]);
		expect(opts?.taskKind).toBe("review");
		expect(opts?.prompt).toBe("find the bug");
	});

	test("the value after --task-kind is not part of the prompt", () => {
		const opts = parseCLIArgs(["--cli", "--task-kind", "code", "write", "a", "debounce"]);
		expect(opts?.prompt).toBe("write a debounce");
	});

	test("omitting it builds the same request as before #3461", () => {
		const opts = parseCLIArgs(["--cli", "--model", "m1", "hello"])!;
		expect(opts.taskKind).toBeUndefined();
		expect(opts.taskKindError).toBeUndefined();
		const req = buildCLIChatRequest(opts);
		expect("taskKind" in req).toBe(false);
		expect(Object.keys(req)).toEqual(["messages", "model"]);
		expect(req.messages[1]).toEqual({ role: "user", content: "hello" });
		// With the flag on and no kind, the policy leaves the request alone.
		expect(applyEffortPolicy(req, ON)).toBe(req);
	});

	test("with the kind given but the flag unset, the policy changes nothing", () => {
		const req = buildCLIChatRequest(parseCLIArgs(["--cli", "--task-kind", "review", "x"])!);
		expect(applyEffortPolicy(req, {})).toBe(req);
		expect(applyEffortPolicy(req, { EIGHT_EFFORT_POLICY: "true" })).toBe(req);
	});

	test("an invalid or missing value is rejected, never passed on", () => {
		for (const args of [
			["--cli", "--task-kind", "security", "x"],
			["--cli", "--task-kind=creative", "x"],
			["--cli", "--task-kind=", "x"],
			["--cli", "x", "--task-kind"],
		]) {
			const opts = parseCLIArgs(args)!;
			expect(opts.taskKind).toBeUndefined();
			expect(opts.taskKindError).toContain("Invalid --task-kind");
			expect("taskKind" in buildCLIChatRequest(opts)).toBe(false);
		}
	});

	test("8gent --cli exits 1 on an invalid kind before calling any model", () => {
		const proc = spawnCli(["--cli", "--json", "--task-kind", "bogus", "hello"]);
		expect(proc.exitCode).toBe(1);
		const out = JSON.parse(proc.stdout.trim().split("\n").pop()!);
		expect(out.error).toContain("Invalid --task-kind");
		expect(out.exitCode).toBe(1);
	});

	test("repeated --task-kind: the last one wins", () => {
		const both = parseCLIArgs(["--cli", "--task-kind", "simple", "--task-kind=review", "x"])!;
		expect(both.taskKind).toBe("review");
		expect(both.taskKindError).toBeUndefined();
		const fixed = parseCLIArgs(["--cli", "--task-kind", "bogus", "--task-kind", "code", "x"])!;
		expect(fixed.taskKind).toBe("code");
		expect(fixed.taskKindError).toBeUndefined();
		const broken = parseCLIArgs(["--cli", "--task-kind", "code", "--task-kind", "bogus", "x"])!;
		expect(broken.taskKind).toBeUndefined();
		expect(broken.taskKindError).toContain("Invalid --task-kind");
	});

	test("--task-kind --json takes --json as the value and is rejected", () => {
		const opts = parseCLIArgs(["--cli", "--task-kind", "--json", "hello"])!;
		expect(opts.taskKind).toBeUndefined();
		expect(opts.taskKindError).toContain('"--json"');
		expect(opts.jsonMode).toBe(true);
	});

	test("8gent --cli --task-kind --json prints the error as JSON and exits 1", () => {
		const proc = spawnCli(["--cli", "--task-kind", "--json", "hello"]);
		expect(proc.exitCode).toBe(1);
		const out = JSON.parse(proc.stdout.trim().split("\n").pop()!);
		expect(out).toEqual({ error: expect.stringContaining("Invalid --task-kind"), exitCode: 1 });
	});

	test("accepted kinds are exactly the policy table's kinds", () => {
		expect([...CLI_TASK_KINDS].sort() as string[]).toEqual(Object.keys(EFFORT_BY_TASK_KIND).sort());
		for (const k of CLI_TASK_KINDS) expect(EFFORT_BY_TASK_KIND[k]).toBeDefined();
	});
});

describe("--cli --json usage and thinking", () => {
	const realFetch = globalThis.fetch;
	const OLD_KEYS = ["response", "files_created", "files_modified", "model", "provider", "exitCode"];
	const ISOLATED_ENV = [
		"HOME",
		"EIGHT_DATA_DIR",
		"OPENAI_API_KEY",
		"ANTHROPIC_API_KEY",
		"EIGHT_EFFORT_POLICY",
	] as const;
	let saved: Array<readonly [string, string | undefined]>;
	let dir: string;

	beforeEach(() => {
		dir = fs.mkdtempSync(path.join(os.tmpdir(), "cli-json-"));
		saved = ISOLATED_ENV.map((k) => [k, process.env[k]] as const);
		process.env.HOME = dir;
		process.env.EIGHT_DATA_DIR = path.join(dir, ".8gent");
		delete process.env.OPENAI_API_KEY;
		delete process.env.ANTHROPIC_API_KEY;
		delete process.env.EIGHT_EFFORT_POLICY;
	});

	afterEach(() => {
		globalThis.fetch = realFetch;
		for (const [k, v] of saved) {
			if (v === undefined) delete process.env[k];
			else process.env[k] = v;
		}
		fs.rmSync(dir, { recursive: true, force: true });
	});

	/** Runs the --cli request path through a real ProviderManager with fetch stubbed. */
	async function runJson(args: string[], body: object): Promise<Record<string, unknown>> {
		{
			const settings = path.join(dir, "providers.json");
			fs.writeFileSync(
				settings,
				JSON.stringify({
					activeProvider: "openai",
					activeModel: "gpt-test",
					providers: { openai: { enabled: true, apiKey: "test-key" } },
				}),
			);
			globalThis.fetch = (async () =>
				new Response(JSON.stringify(body), {
					status: 200,
					headers: { "Content-Type": "application/json" },
				})) as unknown as typeof fetch;
			const opts = parseCLIArgs(["--cli", "--json", ...args, "hello"])!;
			const res = await new ProviderManager(settings).chat(buildCLIChatRequest(opts));
			return JSON.parse(JSON.stringify(buildCLIResult(res, [], [])));
		}
	}

	test("carries usage and thinking when the provider returns them", async () => {
		process.env.EIGHT_EFFORT_POLICY = "1";
		const out = await runJson(["--task-kind", "review"], {
			choices: [{ message: { content: "ok" } }],
			usage: { prompt_tokens: 12, completion_tokens: 34, total_tokens: 46 },
		});
		expect(out.usage).toEqual({ promptTokens: 12, completionTokens: 34, totalTokens: 46 });
		expect(out.thinking).toMatchObject({ requested: "high", level: "high", downgraded: false });
		expect(out.response).toBe("ok");
	});

	test("omits both keys when the provider returns neither (default output unchanged)", async () => {
		delete process.env.EIGHT_EFFORT_POLICY;
		const out = await runJson([], { choices: [{ message: { content: "ok" } }] });
		expect(Object.keys(out)).toEqual(OLD_KEYS);
	});

	test("flag unset with a task kind: usage only, no thinking", async () => {
		delete process.env.EIGHT_EFFORT_POLICY;
		const out = await runJson(["--task-kind", "review"], {
			choices: [{ message: { content: "ok" } }],
			usage: { prompt_tokens: 1, completion_tokens: 2, total_tokens: 3 },
		});
		expect(out.usage).toEqual({ promptTokens: 1, completionTokens: 2, totalTokens: 3 });
		expect("thinking" in out).toBe(false);
	});

	test("buildCLIResult copies only what is present", () => {
		const base = { content: "x", model: "m", provider: "openai" as const };
		expect(Object.keys(buildCLIResult(base, [], []))).toEqual(OLD_KEYS);
		const withUsage = buildCLIResult(
			{ ...base, usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 } },
			[],
			[],
		);
		expect(Object.keys(withUsage)).toEqual([...OLD_KEYS, "usage"]);
	});
});
