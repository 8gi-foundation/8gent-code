import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { TaskCategory } from "../ai/task-router";
import {
	EFFORT_BY_TASK_KIND,
	applyEffortPolicy,
	effortForTaskKind,
	isEffortPolicyEnabled,
} from "./effort-policy";
import { type ChatRequest, ProviderManager } from "./index";
import { resolveThinkingLevel } from "./thinking-level";

const ON = { EIGHT_EFFORT_POLICY: "1" };
const OFF_VALUES: Array<string | undefined> = [undefined, "", "0", "true", " 1", "1 ", "yes", "on"];

describe("isEffortPolicyEnabled", () => {
	test("on only for exactly '1'", () => {
		expect(isEffortPolicyEnabled(ON)).toBe(true);
	});
	for (const v of OFF_VALUES) {
		test(`off for ${JSON.stringify(v)}`, () => {
			expect(isEffortPolicyEnabled({ EIGHT_EFFORT_POLICY: v })).toBe(false);
		});
	}
	test("off when the key is absent", () => {
		expect(isEffortPolicyEnabled({})).toBe(false);
	});
});

describe("effortForTaskKind table", () => {
	const cases: Array<[TaskCategory, string | undefined]> = [
		["simple", "low"],
		["code", "medium"],
		["reasoning", "high"],
		["creative", undefined],
	];
	for (const [kind, level] of cases) {
		test(`${kind} -> ${level ?? "provider default"}`, () => {
			expect(effortForTaskKind(kind)).toBe(level as never);
		});
	}
	test("unknown, empty and prototype keys leave the provider default", () => {
		for (const k of [undefined, "", "security", "toString", "__proto__", "constructor"]) {
			expect(effortForTaskKind(k)).toBeUndefined();
		}
	});
	test("table only names existing TaskCategory values", () => {
		const known: TaskCategory[] = ["code", "reasoning", "simple", "creative"];
		for (const k of Object.keys(EFFORT_BY_TASK_KIND)) {
			expect(known).toContain(k as TaskCategory);
		}
	});
});

describe("applyEffortPolicy", () => {
	const base: ChatRequest = { messages: [], taskKind: "reasoning" };

	for (const v of OFF_VALUES) {
		test(`flag ${JSON.stringify(v)}: returns the same object, untouched`, () => {
			const req = { ...base };
			const snapshot = JSON.stringify(req);
			const out = applyEffortPolicy(req, { EIGHT_EFFORT_POLICY: v });
			expect(out).toBe(req);
			expect(JSON.stringify(out)).toBe(snapshot);
			expect("thinking" in out).toBe(false);
		});
	}

	test("flag on: fills thinking from the task kind", () => {
		expect(applyEffortPolicy({ ...base, taskKind: "simple" }, ON).thinking).toBe("low");
		expect(applyEffortPolicy({ ...base, taskKind: "code" }, ON).thinking).toBe("medium");
		expect(applyEffortPolicy({ ...base, taskKind: "reasoning" }, ON).thinking).toBe("high");
	});

	test("flag on: does not mutate the caller's object", () => {
		const req = { ...base };
		const out = applyEffortPolicy(req, ON);
		expect(out).not.toBe(req);
		expect("thinking" in req).toBe(false);
	});

	test("flag on: explicit caller value always wins", () => {
		for (const level of ["minimal", "low", "medium", "high"] as const) {
			const req = { ...base, thinking: level };
			const out = applyEffortPolicy(req, ON);
			expect(out).toBe(req);
			expect(out.thinking).toBe(level);
		}
	});

	test("flag on: no kind, unknown kind or creative leaves the request unchanged", () => {
		for (const taskKind of [undefined, "security", "creative"]) {
			const req: ChatRequest = { messages: [], taskKind };
			expect(applyEffortPolicy(req, ON)).toBe(req);
		}
	});

	test("policy level downgrades through resolveThinkingLevel", () => {
		const out = applyEffortPolicy({ ...base }, ON);
		expect(resolveThinkingLevel(out.thinking!, ["minimal", "low", "medium", "high"])).toBe("high");
		expect(resolveThinkingLevel(out.thinking!, ["minimal", "low"])).toBe("low");
		expect(resolveThinkingLevel(out.thinking!, [])).toBeNull();
	});
});

// ── Call site: ProviderManager.chat() ────────────────────────────────────

describe("ProviderManager.chat with the effort policy", () => {
	let tmpDir: string;
	let settingsPath: string;
	const realFetch = globalThis.fetch;
	const realFlag = process.env.EIGHT_EFFORT_POLICY;
	let captured: Record<string, unknown> | null;

	beforeEach(() => {
		tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "effort-policy-"));
		settingsPath = path.join(tmpDir, "providers.json");
		fs.writeFileSync(
			settingsPath,
			JSON.stringify({
				activeProvider: "openai",
				activeModel: "gpt-test",
				providers: { openai: { enabled: true, apiKey: "test-key" } },
			}),
		);
		captured = null;
		globalThis.fetch = (async (_url: string, init: { body: string }) => {
			captured = JSON.parse(init.body);
			return new Response(JSON.stringify({ choices: [{ message: { content: "ok" } }] }), {
				status: 200,
				headers: { "Content-Type": "application/json" },
			});
		}) as unknown as typeof fetch;
	});

	afterEach(() => {
		globalThis.fetch = realFetch;
		if (realFlag === undefined) delete process.env.EIGHT_EFFORT_POLICY;
		else process.env.EIGHT_EFFORT_POLICY = realFlag;
		fs.rmSync(tmpDir, { recursive: true, force: true });
	});

	const ask = (extra: Record<string, unknown>) =>
		new ProviderManager(settingsPath).chat({
			messages: [{ role: "user", content: "check this diff" }],
			...extra,
		});

	for (const v of OFF_VALUES) {
		test(`flag ${JSON.stringify(v)}: no reasoning_effort, no taskKind on the wire`, async () => {
			if (v === undefined) delete process.env.EIGHT_EFFORT_POLICY;
			else process.env.EIGHT_EFFORT_POLICY = v;
			const res = await ask({ taskKind: "reasoning" });
			expect(captured).not.toBeNull();
			expect(captured!.reasoning_effort).toBeUndefined();
			expect(captured!.taskKind).toBeUndefined();
			expect(res.thinking).toBeUndefined();
		});
	}

	test("flag on: task kind becomes reasoning_effort", async () => {
		process.env.EIGHT_EFFORT_POLICY = "1";
		const res = await ask({ taskKind: "reasoning" });
		expect(captured!.reasoning_effort).toBe("high");
		expect(captured!.taskKind).toBeUndefined();
		expect(res.thinking?.requested).toBe("high");
	});

	test("flag on: explicit caller thinking wins over the task kind", async () => {
		process.env.EIGHT_EFFORT_POLICY = "1";
		await ask({ taskKind: "reasoning", thinking: "minimal" });
		expect(captured!.reasoning_effort).toBe("minimal");
	});

	test("flag on: unknown kind leaves the provider default", async () => {
		process.env.EIGHT_EFFORT_POLICY = "1";
		const res = await ask({ taskKind: "security" });
		expect(captured!.reasoning_effort).toBeUndefined();
		expect(res.thinking).toBeUndefined();
	});
});
