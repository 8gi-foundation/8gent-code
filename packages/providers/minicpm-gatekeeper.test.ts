/**
 * MiniCPM5-1B gatekeeper wiring tests (#2742).
 *
 * Verifies the flag-gated seats: default behavior is UNCHANGED with flags off,
 * and MiniCPM5-1B + a fully-local (no-cloud) path is selected with flags on.
 * Pure config/parse tests — no network.
 */

import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test } from "bun:test";
import { JudgeScorer, stripThink } from "../kernel/judge";
import { defaultLocalJudge, parseJudgeJson } from "../goal/judge-failover";
import { loadRouterConfig } from "../ai/task-router";

const ROUTER = "EIGHT_ROUTER_MINICPM";
const JUDGE = "EIGHT_JUDGE_MINICPM";
const MINICPM = "openbmb/minicpm5:latest";
const REPO = join(import.meta.dir, "..", "..");

afterEach(() => {
	delete process.env[ROUTER];
	delete process.env[JUDGE];
});

/**
 * Run a snippet in a fresh Bun process with an isolated (empty) HOME so it hits
 * the CODE defaults (defaultTextChains / DEFAULT_CONFIG) rather than the dev
 * host's persisted ~/.8gent/*.json. Needed because os.homedir() ignores an
 * in-process HOME change and task-router binds CONFIG_DIR at import time.
 */
function runInCleanHome(code: string): string {
	const home = mkdtempSync(join(tmpdir(), "minicpm-gk-"));
	const proc = Bun.spawnSync(["bun", "-e", code], {
		cwd: REPO,
		env: { ...process.env, HOME: home },
	});
	return new TextDecoder().decode(proc.stdout).trim();
}

describe("stripThink", () => {
	test("removes a balanced <think> block", () => {
		expect(stripThink('<think>reasoning here</think>\n{"score":1}')).toBe('{"score":1}');
	});
	test("removes a truncated (unclosed) <think> block", () => {
		expect(stripThink("<think>never closed ...")).toBe("");
	});
	test("is a no-op when there is no think block", () => {
		expect(stripThink('{"score":0.5}')).toBe('{"score":0.5}');
	});
});

describe("Seat 0: failover chain for MiniCPM (code default, clean HOME)", () => {
	test("resolves MiniCPM to LOCAL ollama, never openrouter", () => {
		const out = runInCleanHome(
			`import { ModelFailover } from "${join(REPO, "packages/providers/failover")}";` +
				`const f = new ModelFailover();` +
				`console.log(JSON.stringify(f.resolve("${MINICPM}", "text")));`,
		);
		const entry = JSON.parse(out);
		expect(entry.provider).toBe("ollama");
		expect(entry.model).toBe(MINICPM);
		expect(entry.provider).not.toBe("openrouter");
	});
	test("local fallback tier is apple-foundation (no cloud tail)", () => {
		const out = runInCleanHome(
			`import { ModelFailover } from "${join(REPO, "packages/providers/failover")}";` +
				`const f = new ModelFailover();` +
				`f.markDown("${MINICPM}", "ollama");` +
				`console.log(JSON.stringify(f.resolve("${MINICPM}", "text")));`,
		);
		const entry = JSON.parse(out);
		expect(entry.provider).toBe("apple-foundation");
		expect(entry.provider).not.toBe("openrouter");
	});
});

describe("Seat 1: router classifier flag", () => {
	test("code default (clean HOME) is qwen3.5, not MiniCPM", () => {
		const out = runInCleanHome(
			`import { loadRouterConfig } from "${join(REPO, "packages/ai/task-router")}";` +
				`console.log(loadRouterConfig().classifierModel);`,
		);
		expect(out).toBe("qwen3.5:latest");
	});
	test("flag OFF -> classifier is NOT forced to MiniCPM", () => {
		const cfg = loadRouterConfig();
		expect(cfg.classifierModel).not.toBe(MINICPM);
	});
	test("flag ON -> classifier is MiniCPM on ollama (overrides persisted)", () => {
		process.env[ROUTER] = "1";
		const cfg = loadRouterConfig();
		expect(cfg.classifierModel).toBe(MINICPM);
		expect(cfg.classifierProvider).toBe("ollama");
	});
});

describe("Seat 2a: kernel judge flag", () => {
	test("flag OFF -> cloud Gemini-Flash via OpenRouter (unchanged)", () => {
		const cfg = (new JudgeScorer() as unknown as { config: { prmModel: string; prmUrl: string } }).config;
		expect(cfg.prmModel).toBe("google/gemini-2.5-flash:free");
		expect(cfg.prmUrl).toContain("openrouter.ai");
	});
	test("flag ON -> local MiniCPM, no OpenRouter host", () => {
		process.env[JUDGE] = "1";
		const cfg = (new JudgeScorer() as unknown as { config: { prmModel: string; prmUrl: string } }).config;
		expect(cfg.prmModel).toBe(MINICPM);
		expect(cfg.prmUrl).toContain("localhost");
		expect(cfg.prmUrl).not.toContain("openrouter.ai");
	});
	test("explicit caller override still wins over the flag", () => {
		process.env[JUDGE] = "1";
		const cfg = (
			new JudgeScorer({ prmModel: "custom-model" }) as unknown as { config: { prmModel: string } }
		).config;
		expect(cfg.prmModel).toBe("custom-model");
	});
});

describe("Seat 2b: goal-loop local judge flag", () => {
	test("flag OFF -> apple-foundationmodel (unchanged)", () => {
		expect(defaultLocalJudge()).toBe("apple-foundationmodel");
	});
	test("flag ON -> MiniCPM", () => {
		process.env[JUDGE] = "1";
		expect(defaultLocalJudge()).toBe(MINICPM);
	});
	test("parseJudgeJson strips a <think> block that contains braces", () => {
		const raw = '<think>maybe {"done":true}? let me check</think>\n{"done":false,"confidence":0.9,"reason":"missing base case"}';
		const parsed = parseJudgeJson(raw);
		expect(parsed.done).toBe(false);
		expect(parsed.confidence).toBe(0.9);
	});
});
