import { afterEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { applyEffortPolicy } from "../providers/effort-policy";
import { ProviderManager } from "../providers/index";
import { CLI_TASK_KINDS, buildCLIChatRequest, buildCLIResult, parseCLIArgs } from "./cli";

const ON = { EIGHT_EFFORT_POLICY: "1" };

describe("--cli --task-kind", () => {
	test("each accepted kind reaches applyEffortPolicy and sets thinking when the flag is on", () => {
		const expected = { simple: "low", code: "medium", reasoning: "high", review: "high" };
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
		const home = fs.mkdtempSync(path.join(os.tmpdir(), "cli-task-kind-"));
		try {
			const bin = path.join(import.meta.dir, "..", "..", "bin", "8gent.ts");
			const proc = Bun.spawnSync(
				[process.execPath, bin, "--cli", "--json", "--task-kind", "bogus", "hello"],
				{
					env: { ...process.env, HOME: home, TMPDIR: home, EIGHT_HOME: path.join(home, ".8gent") },
				},
			);
			expect(proc.exitCode).toBe(1);
			const out = JSON.parse(proc.stdout.toString().trim().split("\n").pop()!);
			expect(out.error).toContain("Invalid --task-kind");
			expect(out.exitCode).toBe(1);
		} finally {
			fs.rmSync(home, { recursive: true, force: true });
		}
	});
});

describe("--cli --json usage and thinking", () => {
	const realFetch = globalThis.fetch;
	const realFlag = process.env.EIGHT_EFFORT_POLICY;
	const OLD_KEYS = ["response", "files_created", "files_modified", "model", "provider", "exitCode"];

	afterEach(() => {
		globalThis.fetch = realFetch;
		if (realFlag === undefined) delete process.env.EIGHT_EFFORT_POLICY;
		else process.env.EIGHT_EFFORT_POLICY = realFlag;
	});

	/** Runs the --cli request path through a real ProviderManager with fetch stubbed. */
	async function runJson(args: string[], body: object): Promise<Record<string, unknown>> {
		const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cli-json-"));
		try {
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
		} finally {
			fs.rmSync(dir, { recursive: true, force: true });
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
