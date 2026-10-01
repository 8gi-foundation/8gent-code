/**
 * Tests for the V2 wiring helpers shipped in #2345 + #2346:
 *   - turnEndedInError (how a turn ended)
 *   - useGitSync.computeGitSync with an injected runner
 *   - activity-rail-derivation pure helpers
 *   - tui-approval-channel + a simulated keypress-driven approval flow
 */
import { describe, expect, test, beforeEach } from "bun:test";

import { turnEndedInError } from "../lib/turn-outcome";
import { computeGitSync, gitView, type GitRunner } from "../hooks/useGitSync";
import {
	deriveTools,
	deriveProviders,
	fallbackFromChain,
	deriveAgents,
	deriveActiveTasks,
	parseToolName,
	queuedToolCount,
	planStepsFromText,
} from "../lib/activity-rail-derivation";
import {
	registerTuiApprovalHandler,
	requestTuiApproval,
	hasTuiApprovalHandler,
	_resetTuiApprovalChannel,
	type TuiApprovalDecision,
} from "../../../../packages/permissions/tui-approval-channel";
import { ModelFailover } from "../../../../packages/providers/failover";

function msg(partial: { role: string; content?: string; toolSuccess?: boolean; id?: string; toolTrail?: any }) {
	return {
		id: partial.id ?? `m-${Math.random().toString(36).slice(2, 8)}`,
		role: partial.role as any,
		content: partial.content ?? "",
		toolSuccess: partial.toolSuccess,
		toolTrail: partial.toolTrail,
	};
}

/** A start row and, when `ok` is given, its matching end row, as app.tsx appends them. */
function call(id: string, name: string, ok?: boolean) {
	const start = msg({ role: "tool", id: `tool-start-${id}`, content: `→ ${name}({})` });
	if (ok === undefined) return [start];
	return [
		start,
		msg({
			role: "tool",
			id: `tool-end-${id}`,
			content: ok ? "  ✓" : "  ✗ exit 1",
			toolSuccess: ok,
			toolTrail: { tool: name, summary: "", status: ok ? "ok" : "fail" },
		}),
	];
}

describe("turnEndedInError", () => {
	test("a recovered blocked or failed tool is not a failed turn (pilot l3-bugfix-m5)", () => {
		// The run's real tail: two blocked calls mid-turn, then green tests
		// and the root-cause reply. The header showed `error` for 5 s here.
		const messages = [
			...call("5", "run_command", false),
			...call("6", "run_command", true),
			...call("7", "run_command", false),
			...call("8", "run_command", true),
			msg({ role: "assistant", content: "All 7 tests now pass. The bug was in paginate.ts." }),
		] as any;
		expect(turnEndedInError(messages)).toBe(false);
	});

	test("a turn that ends on an error is a failed turn", () => {
		expect(turnEndedInError([msg({ role: "assistant", content: "[Error] provider timed out" })] as any)).toBe(true);
		expect(turnEndedInError([msg({ role: "system", content: "[Agent not ready] Nothing was run." })] as any)).toBe(true);
		// Stopped on a failed call with no reply after it.
		expect(turnEndedInError([...call("1", "run_command", false)] as any)).toBe(true);
		expect(turnEndedInError([] as any)).toBe(false);
		// The agent's own failed-turn reply, as seen in the before capture:
		// ollama rejected the tool-call markup and the turn stopped.
		expect(
			turnEndedInError([
				...call("1", "run_command", false),
				msg({ role: "assistant", content: 'The local model turn could not complete: ollama chat completions 500: {"error":{"message":"EOF"}}' }),
			] as any),
		).toBe(true);
	});
});

describe("computeGitSync", () => {
	function fakeRunner(map: Record<string, { stdout: string; code?: number }>): GitRunner {
		return async (args) => {
			const key = args.join(" ");
			for (const k of Object.keys(map)) {
				if (key.endsWith(k)) {
					const r = map[k];
					if (r) return { stdout: r.stdout, stderr: "", code: r.code ?? 0 };
				}
			}
			return { stdout: "", stderr: "no match", code: 1 };
		};
	}

	test("up-to-date when both counts are zero", async () => {
		const runner = fakeRunner({
			"rev-parse --is-inside-work-tree": { stdout: "true\n" },
			"rev-parse --abbrev-ref HEAD": { stdout: "main\n" },
			"rev-list --count @{u}..HEAD": { stdout: "0\n" },
			"rev-list --count HEAD..@{u}": { stdout: "0\n" },
		});
		const r = await computeGitSync("/tmp/repo", runner);
		expect(r.status).toBe("up-to-date");
		expect(r.label).toBe("main: up to date");
		expect(r.branch).toBe("main");
	});

	test("ahead when ahead count > 0", async () => {
		const runner = fakeRunner({
			"rev-parse --is-inside-work-tree": { stdout: "true\n" },
			"rev-parse --abbrev-ref HEAD": { stdout: "feat/x\n" },
			"rev-list --count @{u}..HEAD": { stdout: "3\n" },
			"rev-list --count HEAD..@{u}": { stdout: "0\n" },
		});
		const r = await computeGitSync("/tmp/repo", runner);
		expect(r.status).toBe("ahead");
		expect(r.ahead).toBe(3);
		expect(r.label).toBe("feat/x: 3 ahead");
		expect(r.branch).toBe("feat/x");
	});

	test("diverged when both counts > 0", async () => {
		const runner = fakeRunner({
			"rev-parse --is-inside-work-tree": { stdout: "true\n" },
			"rev-parse --abbrev-ref HEAD": { stdout: "main\n" },
			"rev-list --count @{u}..HEAD": { stdout: "1\n" },
			"rev-list --count HEAD..@{u}": { stdout: "2\n" },
		});
		const r = await computeGitSync("/tmp/repo", runner);
		expect(r.status).toBe("diverged");
	});

	test("no-upstream when rev-list errors", async () => {
		const runner = fakeRunner({
			"rev-parse --is-inside-work-tree": { stdout: "true\n" },
			"rev-parse --abbrev-ref HEAD": { stdout: "main\n" },
			"rev-list --count @{u}..HEAD": { stdout: "", code: 128 },
		});
		const r = await computeGitSync("/tmp/repo", runner);
		expect(r.status).toBe("no-upstream");
	});

	test("detached HEAD", async () => {
		const runner = fakeRunner({
			"rev-parse --is-inside-work-tree": { stdout: "true\n" },
			"rev-parse --abbrev-ref HEAD": { stdout: "HEAD\n" },
		});
		const r = await computeGitSync("/tmp/repo", runner);
		expect(r.status).toBe("detached");
		expect(r.branch).toBe("HEAD");
	});

	test("no-repo when rev-parse fails", async () => {
		const runner = fakeRunner({});
		const r = await computeGitSync("/tmp/notrepo", runner);
		expect(r.status).toBe("no-repo");
		expect(r.branch).toBe("");
	});
});

describe("gitView (audit #10: header and rail must agree)", () => {
	const r = (status: Parameters<typeof gitView>[0]["status"], branch = "", ahead = 0, behind = 0) =>
		gitView({ status, branch, ahead, behind });

	test("before the first check nothing is shown", () => {
		expect(r("unknown")).toEqual({ branch: "", sync: "", noRepo: false });
	});

	test("outside a repo: no branch, one fact", () => {
		expect(r("no-repo")).toEqual({ branch: "", sync: "", noRepo: true });
	});

	test("in a repo: the branch and a short note that never repeats it", () => {
		expect(r("up-to-date", "main")).toEqual({ branch: "main", sync: "in sync", noRepo: false });
		expect(r("ahead", "feat/x", 3)).toMatchObject({ branch: "feat/x", sync: "3 ahead" });
		expect(r("behind", "main", 0, 2)).toMatchObject({ sync: "2 behind" });
		expect(r("no-upstream", "wip")).toMatchObject({ branch: "wip", sync: "no upstream" });
		expect(r("detached", "HEAD")).toMatchObject({ branch: "HEAD", sync: "detached" });
	});
});

describe("activity-rail-derivation", () => {
	test("parseToolName extracts name from arrow prefix", () => {
		expect(parseToolName("→ read_file({})")).toBe("read_file");
		expect(parseToolName("> patch(input)")).toBe("patch");
		expect(parseToolName("nope")).toBe(null);
	});

	test("deriveTools pairs start and end rows into one call each", () => {
		const messages = [
			msg({ role: "user", content: "hi" }),
			...call("1", "a", true),
			...call("2", "b", false),
			...call("3", "c"),
		] as any;
		const tools = deriveTools(messages, true, 5);
		expect(tools.map((t) => t.name)).toEqual(["c", "b", "a"]);
		expect(tools.map((t) => t.state)).toEqual(["running", "fail", "ok"]);
	});

	test("finished calls never count as queued, live or idle (audit #4: queued 2 never drained)", () => {
		const messages = [...call("1", "list_files", true), ...call("2", "run_command", true)] as any;
		const live = deriveTools(messages, true, 5);
		expect(live.every((t) => t.state === "ok")).toBe(true);
		expect(queuedToolCount(live, true)).toBe(0);
		expect(queuedToolCount(deriveTools(messages, false, 5), false)).toBe(0);
	});

	test("queued counts calls waiting behind the active one, and drains when the turn ends", () => {
		const messages = [...call("1", "read_file"), ...call("2", "read_file"), ...call("3", "grep")] as any;
		const live = deriveTools(messages, true, 5);
		expect(queuedToolCount(live, true)).toBe(2);
		const after = deriveTools(messages, false, 5);
		expect(after.some((t) => t.state === "running")).toBe(false);
		expect(queuedToolCount(after, false)).toBe(0);
	});

	test("deriveProviders fmts latency and respects tier order", () => {
		const rows = deriveProviders({
			primary: { name: "ollama:eight", latencyMs: 42 },
			fallback: { name: "openrouter:free", latencyMs: 1200 },
			offline: { name: "deepseek-v4-flash" },
		});
		expect(rows.map((r) => r.state)).toEqual(["primary", "fallback", "offline"]);
		expect(rows[0].latency).toBe("42ms");
		// Unmeasured latency has no placeholder glyph: the slot is empty.
		expect(rows[2].latency).toBeUndefined();
	});

	test("the fallback row is the real next hop in the failover chain (#3070)", () => {
		const fo = new ModelFailover({
			text: {
				"ornith-1.0-9b": {
					models: [
						{ model: "ornith-1.0-9b", provider: "lmstudio" },
						{ model: "MiniMax-M2.7", provider: "apfel" },
						{ model: "meta-llama/llama-3-8b-instruct:free", provider: "openrouter" },
					],
				},
			},
			computer: {},
		});
		expect(fallbackFromChain(fo, "lmstudio", "ornith-1.0-9b")).toEqual({ name: "apfel:MiniMax-M2.7" });
		// No chain for the model, no model set, no chain at all: no fallback row.
		expect(fallbackFromChain(fo, "ollama", "qwen3.8:27b-mlx")).toBeNull();
		expect(fallbackFromChain(fo, "lmstudio", "")).toBeNull();
		expect(fallbackFromChain(null, "lmstudio", "ornith-1.0-9b")).toBeNull();
		const rows = deriveProviders({
			primary: { name: "ollama:qwen3.8:27b-mlx" },
			fallback: fallbackFromChain(fo, "ollama", "qwen3.8:27b-mlx"),
			offline: null,
		});
		expect(rows.map((r) => r.state)).toEqual(["primary"]);
	});

	test("deriveAgents collapses statuses and falls back to main", () => {
		expect(deriveAgents([])).toEqual([{ name: "main", state: "idle" }]);
		const rows = deriveAgents([
			{ id: "1", name: "Core", status: "running" },
			{ id: "2", name: "Tester", status: "blocked" },
			{ id: "3", name: "Other", status: "asleep" },
		]);
		expect(rows[0]).toEqual({ name: "Core", state: "active" });
		expect(rows[1]).toEqual({ name: "Tester", state: "blocked" });
		expect(rows[2]).toEqual({ name: "Other", state: "idle" });
	});

	test("TASKS reads the plan: the active step with the real done/total bar", () => {
		const plan = [
			{ id: "p1", text: "read the tests", status: "done" as const },
			{ id: "p2", text: "fix paginate", status: "active" as const },
			{ id: "p3", text: "run bun test", status: "pending" as const },
		];
		expect(deriveActiveTasks(plan, true)).toEqual([
			{ id: "p2", label: "fix paginate", progress: 33, detail: "1/3" },
		]);
	});

	test("TASKS shows the plan tally when no step is in progress", () => {
		const plan = [
			{ id: "p1", text: "a", status: "done" as const },
			{ id: "p2", text: "b", status: "done" as const },
		];
		expect(deriveActiveTasks(plan, false)).toEqual([
			{ id: "plan-tally", label: "2 of 2 steps done", progress: 100, detail: "2/2" },
		]);
	});

	test("TASKS never says idle while a turn runs (audit #4)", () => {
		expect(deriveActiveTasks([], true)).toEqual([{ id: "working", label: "working, no plan yet" }]);
	});

	test("while the approval card waits, TASKS says waiting like every other surface (#3152)", () => {
		expect(deriveActiveTasks([], true, true)).toEqual([
			{ id: "waiting", label: "waiting for your answer", tone: "waiting" },
		]);
		const plan = [{ id: "p1", text: "a", status: "pending" as const }];
		expect(deriveActiveTasks(plan, true, true)[0]).toMatchObject({ id: "waiting", tone: "waiting" });
		// A step in progress is still the task; the card belongs to it.
		const running = [{ id: "p1", text: "run the tests", status: "active" as const }];
		expect(deriveActiveTasks(running, true, true)[0]).toMatchObject({ id: "p1", label: "run the tests" });
	});

	test("a plan-only reply reads as planned, not as an empty 0 of N bar (#3152)", () => {
		const plan = [
			{ id: "p1", text: "a", status: "pending" as const },
			{ id: "p2", text: "b", status: "pending" as const },
			{ id: "p3", text: "c", status: "pending" as const },
		];
		expect(deriveActiveTasks(plan, false)).toEqual([{ id: "plan-tally", label: "3 steps planned", tone: "quiet" }]);
		expect(deriveActiveTasks(plan.slice(0, 1), false)[0].label).toBe("1 step planned");
		// Mid-turn the tally stays: the steps are about to run.
		expect(deriveActiveTasks(plan, true)[0]).toMatchObject({ label: "0 of 3 steps done", detail: "0/3" });
	});

	test("a fresh session with no plan shows no tasks (#2923)", () => {
		// Nothing seeded, nothing invented: no plan and no turn is idle.
		expect(deriveActiveTasks([], false)).toEqual([]);
	});

	test("planStepsFromText only yields steps the agent wrote in a PLAN block", () => {
		// A user's onboarding answer or a plain prompt is not a plan.
		expect(planStepsFromText("James")).toEqual([]);
		expect(planStepsFromText("fix the bug and add a feature then commit")).toEqual([]);
		expect(planStepsFromText("")).toEqual([]);
		expect(planStepsFromText(null)).toEqual([]);
		// A PLAN: block with numbered steps is the real source.
		expect(planStepsFromText("PLAN:\n1. Read app.tsx\n2) Patch the rail\n- Run tests")).toEqual([
			"Read app.tsx",
			"Patch the rail",
			"Run tests",
		]);
		// The block ends at the first blank line.
		expect(planStepsFromText("PLAN:\n1. Only step\n\n1. Not part of the plan")).toEqual([
			"Only step",
		]);
	});
});

describe("tui-approval-channel", () => {
	beforeEach(() => {
		_resetTuiApprovalChannel();
	});

	test("returns null when no handler is registered", async () => {
		expect(hasTuiApprovalHandler()).toBe(false);
		expect(await requestTuiApproval({ action: "x", details: "y" })).toBe(null);
	});

	test("simulated Y keypress resolves to true", async () => {
		// Simulate the TUI registering a handler that itself waits for a
		// keypress. We mock the keypress by resolving on next tick with
		// "approve".
		registerTuiApprovalHandler(async () => {
			return await new Promise<TuiApprovalDecision>((res) => {
				setTimeout(() => res("approve"), 0);
			});
		});
		const ok = await requestTuiApproval({
			action: "write_file",
			details: "patch app.tsx",
			command: undefined,
		});
		expect(ok).toBe(true);
	});

	test("N keypress resolves to false", async () => {
		registerTuiApprovalHandler(async () => "deny");
		const ok = await requestTuiApproval({ action: "x", details: "y" });
		expect(ok).toBe(false);
	});

	test("E and S both resolve to false (legacy boolean caller)", async () => {
		registerTuiApprovalHandler(async () => "edit");
		expect(await requestTuiApproval({ action: "x", details: "y" })).toBe(false);
		registerTuiApprovalHandler(async () => "skip");
		expect(await requestTuiApproval({ action: "x", details: "y" })).toBe(false);
	});

	test("handler that throws returns null so caller can fall back", async () => {
		registerTuiApprovalHandler(async () => {
			throw new Error("boom");
		});
		expect(await requestTuiApproval({ action: "x", details: "y" })).toBe(null);
	});
});

// ============================================
// Readiness wiring in app.tsx (#3290)
// ============================================
// deriveReadiness is pure and tested on its own (lib/readiness.test.ts). These
// read app.tsx itself, so the facts it feeds that function cannot be quietly
// unplugged: each assertion below fails if one wire is cut.
describe("readiness wiring in app.tsx (#3290)", () => {
	const app = require("node:fs").readFileSync(require("node:path").join(import.meta.dir, "..", "app.tsx"), "utf8") as string;
	const initAgent = app.slice(app.indexOf("const initAgent = async () => {"), app.indexOf("initAgent();"));

	test("the engine probe re-runs when the nonce is bumped", () => {
		expect(app).toMatch(/setInterval\(tick, 8000\);[\s\S]{0,160}?\}, \[probeNonce\]\);/);
	});

	test("a finished turn records its fact and acts on it", () => {
		expect(app).toMatch(/const facts = turnEndFacts\(/);
		expect(app).toContain("setTurnError(facts.turnError);");
		expect(app).toContain("if (facts.probeNow) setProbeNonce((n) => n + 1);");
		expect(app).toContain("if (facts.retryBuild) setInitRetry((n) => n + 1);");
	});

	test("built() and waiting() write the build fact, and only for a live attempt", () => {
		expect(initAgent).toMatch(/const built = \(\) => \{\s*if \(cancelled\) return;\s*setBuildFact\(\{ key: buildKey, notice: null \}\);/);
		expect(initAgent).toMatch(/const waiting = \(notice: string\) => \{\s*if \(cancelled\) return;\s*setBuildFact\(\{ key: buildKey, notice \}\);/);
	});

	test("both success paths call built()", () => {
		// The reused agent and the newly built one.
		expect(initAgent.match(/setAgentReady\(true\);\s*built\(\);/g)?.length).toBe(2);
	});

	test("a superseded attempt stops after autoAssign", () => {
		expect(initAgent).toMatch(/await router\.autoAssign\(\);\s*if \(cancelled\) return;/);
	});

	test("the build key uses the same tab id as the render-side key", () => {
		expect(initAgent).toContain("readinessBuildKey(activeTabId, currentProvider, currentModel)");
		expect(app).toContain("buildResultFor(buildFact, readinessBuildKey(activeTabId, currentProvider, currentModel))");
	});

	test("the header strip and the NO MODEL card render from the one readiness", () => {
		// The strip's own element only: up to its first "/>".
		const strip = app.slice(app.indexOf("<LiveFocalStripWithGoal"));
		expect(strip.slice(0, strip.indexOf("/>"))).toContain("readiness={readiness}");
		expect(app).toMatch(/<NoProviderNotice\s+readiness=\{readiness\}/);
		expect(app).toContain("route={readiness.model || \"-\"}");
	});
});
