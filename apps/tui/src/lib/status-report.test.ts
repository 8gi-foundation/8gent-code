/**
 * Contract tests for the /status report and the shared approval mode.
 *
 * /status must answer "what is going on?" in priority order (Running,
 * Waiting on you, Blocked, Plan, Session) and never print a placeholder
 * row for a section that has nothing to say (#2930, part of #2922).
 */

import { describe, expect, test } from "bun:test";
import {
	deriveApprovalMode,
	formatStatusReport,
	type StatusReportState,
} from "./status-report.js";

function base(overrides: Partial<StatusReportState> = {}): StatusReportState {
	return {
		running: [],
		waiting: { approvalTarget: null, onboardingQuestion: null, queued: [] },
		blocked: { provider: "ollama", providerReachable: true, localEngines: { live: 2, total: 3 } },
		plan: { ready: 0, inProgress: 0, done: 0, next: null },
		session: {
			provider: "ollama",
			model: "qwen3.6:27b",
			branch: "main",
			durationMs: 172_000,
			tokens: 0,
		},
		...overrides,
	};
}

describe("formatStatusReport", () => {
	test("empty session: one Idle line and the Session line, nothing else", () => {
		const lines = formatStatusReport(base());
		expect(lines).toEqual([
			"Idle           nothing running, nothing waiting on you",
			"Session        ollama qwen3.6:27b · main · 2m 52s · 0 tok",
		]);
		// No placeholder rows for the empty sections.
		expect(lines.some((l) => l.startsWith("Running"))).toBe(false);
		expect(lines.some((l) => l.startsWith("Waiting"))).toBe(false);
		expect(lines.some((l) => l.startsWith("Blocked"))).toBe(false);
		expect(lines.some((l) => l.startsWith("Plan"))).toBe(false);
	});

	test("running: one row per active tab with elapsed and the current tool", () => {
		const lines = formatStatusReport(
			base({
				running: [
					{ title: "Orchestrator", elapsedMs: 12_000, tool: "Bash" },
					{ title: "Engineer", elapsedMs: 65_000, tool: null },
				],
			}),
		);
		expect(lines[0]).toBe("Running        Orchestrator  12s  Bash");
		expect(lines[1]).toBe("               Engineer  1m 5s");
		expect(lines.some((l) => l.startsWith("Idle"))).toBe(false);
		expect(lines.at(-1)).toMatch(/^Session {8}/);
	});

	test("waiting: approval, onboarding question and queued follow-ups", () => {
		const lines = formatStatusReport(
			base({
				running: [{ title: "Engineer", elapsedMs: 3_000 }],
				waiting: {
					approvalTarget: "rm -rf dist",
					onboardingQuestion: "What should I call you?",
					queued: [
						{ title: "Engineer", count: 2 },
						{ title: "QA", count: 0 },
					],
				},
			}),
		);
		expect(lines).toEqual([
			"Running        Engineer  3s",
			"Waiting on you approve? rm -rf dist",
			"               answer: What should I call you?",
			"               2 queued on Engineer",
			"Session        ollama qwen3.6:27b · main · 2m 52s · 0 tok",
		]);
	});

	test("blocked: provider unreachable names the provider and the engine count", () => {
		const lines = formatStatusReport(
			base({
				blocked: { provider: "lmstudio", providerReachable: false, localEngines: { live: 0, total: 3 } },
			}),
		);
		expect(lines[0]).toBe("Blocked        lmstudio unreachable · local engines 0/3 up");
		expect(lines.some((l) => l.startsWith("Idle"))).toBe(false);
	});

	test("blocked: no engine count when the probe has not reported", () => {
		const lines = formatStatusReport(
			base({
				blocked: { provider: "openrouter", providerReachable: false, localEngines: null },
			}),
		);
		expect(lines[0]).toBe("Blocked        openrouter unreachable");
	});

	test("plan: real counts and the next step; omitted when the board is empty", () => {
		const lines = formatStatusReport(
			base({
				plan: { ready: 2, inProgress: 1, done: 3, next: "Run the test suite" },
			}),
		);
		expect(lines).toContain("Plan           ready 2 · in progress 1 · done 3");
		expect(lines).toContain("               next: Run the test suite");

		const onlyNext = formatStatusReport(
			base({ plan: { ready: 0, inProgress: 0, done: 0, next: "Write the PR" } }),
		);
		expect(onlyNext.filter((l) => l.startsWith("Plan"))).toEqual(["Plan           next: Write the PR"]);
	});

	test("session: omits model and branch when unknown, formats tokens", () => {
		const lines = formatStatusReport(
			base({
				session: { provider: "apfel", model: null, branch: null, durationMs: 5_000, tokens: 12_345 },
			}),
		);
		expect(lines.at(-1)).toBe("Session        apfel · 5s · 12,345 tok");
	});

	test("long free text is clipped to one line", () => {
		const long = "x".repeat(200);
		const lines = formatStatusReport(base({ waiting: { approvalTarget: long, onboardingQuestion: null, queued: [] } }));
		const row = lines.find((l) => l.startsWith("Waiting on you")) ?? "";
		expect(row.length).toBeLessThanOrEqual(15 + "approve? ".length + 60);
		expect(row.endsWith("…")).toBe(true);
	});
});

describe("deriveApprovalMode", () => {
	test("ask by default", () => {
		expect(
			deriveApprovalMode({ approvalPending: false, infiniteModeActive: false, cliAutoApprove: false }),
		).toBe("ask");
	});

	test("auto when the session runs autonomously", () => {
		expect(
			deriveApprovalMode({ approvalPending: false, infiniteModeActive: true, cliAutoApprove: false }),
		).toBe("auto");
		expect(
			deriveApprovalMode({ approvalPending: false, infiniteModeActive: false, cliAutoApprove: true }),
		).toBe("auto");
	});

	test("waiting wins whenever an approval is pending", () => {
		expect(
			deriveApprovalMode({ approvalPending: true, infiniteModeActive: false, cliAutoApprove: false }),
		).toBe("waiting");
		expect(
			deriveApprovalMode({ approvalPending: true, infiniteModeActive: true, cliAutoApprove: true }),
		).toBe("waiting");
	});
});
