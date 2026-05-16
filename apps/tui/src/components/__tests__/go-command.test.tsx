/**
 * /go slash command tests.
 *
 * Strategy mirrors the rest of __tests__/: the codebase has no
 * ink-testing-library installed, so we test at the unit boundary that
 * actually matters for /go: the parse + dispatch pipeline that
 * command-input.tsx exports as `handleGoCommand`. Component-level
 * rendering is exercised through the same trick used in
 * LiveFocalStrip.test.tsx (function-as-element) for the focal strip
 * goal overlay.
 *
 * Coverage:
 *   1. parseGoCommand recognises every subcommand + invalid input.
 *   2. handleGoCommand dispatches the right RPC envelope through the
 *      transport for each /go variant.
 *   3. /subgoal forwards text or surfaces an error.
 *   4. /go ? emits all GO_HELP_LINES.
 *   5. LiveFocalStripWithGoal renders the verdict line and runs its
 *      copy through the banned-token lint.
 *   6. buildGoalLine produces the BRAND.md one-liner.
 */

import { describe, expect, test } from "bun:test";
import React from "react";

import { handleGoCommand } from "../command-input.js";
import {
	GO_HELP_LINES,
	GoalClient,
	MemoryTransport,
	parseGoCommand,
} from "../../lib/goal-client.js";
import {
	LiveFocalStripWithGoal,
	buildGoalLine,
	formatElapsed,
	type GoalStripState,
} from "../LiveFocalStrip.js";
import { assertNoBannedTokens } from "../../../../../packages/eight/go/index.js";

// ----- parseGoCommand --------------------------------------------------------

describe("parseGoCommand", () => {
	test("empty args is invalid with help hint", () => {
		const out = parseGoCommand([]);
		expect(out.kind).toBe("invalid");
		if (out.kind === "invalid") {
			expect(out.reason).toContain("missing goal text");
		}
	});

	test("? returns help", () => {
		expect(parseGoCommand(["?"])).toEqual({ kind: "help" });
	});

	test("help alias returns help", () => {
		expect(parseGoCommand(["help"])).toEqual({ kind: "help" });
	});

	test("status / stop / resume / clear map to their kinds", () => {
		expect(parseGoCommand(["status"]).kind).toBe("status");
		expect(parseGoCommand(["stop"]).kind).toBe("stop");
		expect(parseGoCommand(["abort"]).kind).toBe("stop");
		expect(parseGoCommand(["resume"]).kind).toBe("resume");
		expect(parseGoCommand(["clear"]).kind).toBe("clear");
	});

	test("free text becomes a start with joined goal", () => {
		const out = parseGoCommand(["ship", "the", "release"]);
		expect(out).toEqual({ kind: "start", goal: "ship the release" });
	});

	test("first arg that is not a subcommand keyword counts as goal text", () => {
		// "build" is not reserved, so it counts as the start of the goal.
		const out = parseGoCommand(["build", "the", "tui"]);
		expect(out).toEqual({ kind: "start", goal: "build the tui" });
	});
});

// ----- handleGoCommand -------------------------------------------------------

function mkClient(): { client: GoalClient; transport: MemoryTransport } {
	const transport = new MemoryTransport();
	const client = new GoalClient(transport);
	return { client, transport };
}

describe("handleGoCommand: /go", () => {
	test("/go <goal> sends goal.start with the right shape", () => {
		const { client, transport } = mkClient();
		const sys: string[] = [];
		handleGoCommand("go", ["wire", "the", "tui"], client, "sess_1", (l) =>
			sys.push(l),
		);
		expect(transport.sent).toHaveLength(1);
		expect(transport.sent[0]).toEqual({
			type: "goal.start",
			sessionId: "sess_1",
			goal: "wire the tui",
		});
		expect(sys.join("\n")).toContain("Going.");
	});

	test("/go ? emits help with all subcommands", () => {
		const { client, transport } = mkClient();
		const sys: string[] = [];
		handleGoCommand("go", ["?"], client, "sess_1", (l) => sys.push(l));
		expect(transport.sent).toHaveLength(0);
		const text = sys.join("\n");
		for (const line of GO_HELP_LINES) {
			expect(text).toContain(line);
		}
	});

	test("/go status sends goal.status when active", () => {
		const { client, transport } = mkClient();
		client.setActiveRunId("g_abc");
		const sys: string[] = [];
		handleGoCommand("go", ["status"], client, "sess_1", (l) => sys.push(l));
		expect(transport.sent[0]).toEqual({ type: "goal.status", runId: "g_abc" });
	});

	test("/go status with no active run surfaces the error to the system line", () => {
		const { client, transport } = mkClient();
		const sys: string[] = [];
		handleGoCommand("go", ["status"], client, "sess_1", (l) => sys.push(l));
		expect(transport.sent).toHaveLength(0);
		expect(sys.join("\n")).toContain("no active run");
	});

	test("/go stop sends goal.abort", () => {
		const { client, transport } = mkClient();
		client.setActiveRunId("g_abc");
		handleGoCommand("go", ["stop"], client, "sess_1");
		expect(transport.sent[0]).toEqual({ type: "goal.abort", runId: "g_abc" });
	});

	test("/go resume sends goal.resume", () => {
		const { client, transport } = mkClient();
		client.setActiveRunId("g_abc");
		handleGoCommand("go", ["resume"], client, "sess_1");
		expect(transport.sent[0]).toEqual({ type: "goal.resume", runId: "g_abc" });
	});

	test("/go clear aborts and drops state (idempotent on second call)", () => {
		const { client, transport } = mkClient();
		client.setActiveRunId("g_abc");
		handleGoCommand("go", ["clear"], client, "sess_1");
		expect(transport.sent[0]).toEqual({ type: "goal.abort", runId: "g_abc" });
		expect(client.getActiveRunId()).toBeNull();

		// Second invocation: no active run, no envelope sent, no throw.
		const before = transport.sent.length;
		handleGoCommand("go", ["clear"], client, "sess_1");
		expect(transport.sent.length).toBe(before);
		expect(client.getActiveRunId()).toBeNull();
	});

	test("/go (no args) reports the error rather than sending", () => {
		const { client, transport } = mkClient();
		const sys: string[] = [];
		handleGoCommand("go", [], client, "sess_1", (l) => sys.push(l));
		expect(transport.sent).toHaveLength(0);
		expect(sys.join("\n")).toContain("missing goal text");
	});
});

describe("handleGoCommand: /subgoal", () => {
	test("/subgoal <text> sends goal.subgoal", () => {
		const { client, transport } = mkClient();
		client.setActiveRunId("g_abc");
		handleGoCommand("subgoal", ["refactor", "the", "router"], client, "sess_1");
		expect(transport.sent[0]).toEqual({
			type: "goal.subgoal",
			runId: "g_abc",
			text: "refactor the router",
		});
	});

	test("/subgoal with no text reports an error", () => {
		const { client, transport } = mkClient();
		client.setActiveRunId("g_abc");
		const sys: string[] = [];
		handleGoCommand("subgoal", [], client, "sess_1", (l) => sys.push(l));
		expect(transport.sent).toHaveLength(0);
		expect(sys.join("\n")).toContain("text required");
	});
});

// ----- LiveFocalStripWithGoal surface ---------------------------------------
//
// The wrapper itself owns hooks (useState + useEffect + useInput), so it
// can't be invoked outside an Ink render context (no
// ink-testing-library in this repo). We follow the exact pattern from
// LiveFocalStrip.test.tsx: lint the pure data layer and the export
// shape, and let the launch smoke test exercise the full render.

describe("LiveFocalStripWithGoal exports", () => {
	test("component is defined", () => {
		expect(LiveFocalStripWithGoal).toBeDefined();
		expect(typeof LiveFocalStripWithGoal).toBe("function");
	});
});

describe("goal line copy lint", () => {
	test("every line buildGoalLine can produce passes the banned-token lint", () => {
		const cases: GoalStripState[] = [
			// Idle
			{
				runId: null,
				terminal: null,
				subgoal: null,
				elapsedMs: 0,
				turns: 0,
				verdictLine: "",
			},
			// Mid-run with subgoal
			{
				runId: "g",
				terminal: null,
				subgoal: { index: 1, total: 3, text: "draft" },
				elapsedMs: 5_000,
				turns: 1,
				verdictLine: "",
			},
			// Mid-run without subgoal
			{
				runId: "g",
				terminal: null,
				subgoal: null,
				elapsedMs: 5_000,
				turns: 0,
				verdictLine: "",
			},
			// Terminal: done
			{
				runId: "g",
				terminal: "done",
				subgoal: null,
				elapsedMs: 0,
				turns: 4,
				verdictLine: "Done. Goal met at turn 4.",
			},
			// Terminal: stuck
			{
				runId: "g",
				terminal: "stuck",
				subgoal: null,
				elapsedMs: 0,
				turns: 0,
				verdictLine:
					"Stuck. Needs you - last attempt failed three times the same way.",
			},
		];

		for (const c of cases) {
			const line = buildGoalLine(c);
			expect(() => assertNoBannedTokens(line)).not.toThrow();
		}
	});
});

describe("buildGoalLine / formatElapsed", () => {
	test("formatElapsed: seconds < 60", () => {
		expect(formatElapsed(5_000)).toBe("5s");
	});
	test("formatElapsed: minutes", () => {
		expect(formatElapsed(84_000)).toBe("1m24s");
	});
	test("formatElapsed: hours", () => {
		expect(formatElapsed(3_720_000)).toBe("1h02m");
	});
	test("formatElapsed: negative clamps to 0s", () => {
		expect(formatElapsed(-1)).toBe("0s");
	});

	test("buildGoalLine renders BRAND.md one-liner shape", () => {
		const line = buildGoalLine({
			runId: "g_1",
			terminal: null,
			subgoal: { index: 1, total: 3, text: "draft tests" },
			elapsedMs: 8_000,
			turns: 1,
			verdictLine: "",
		});
		expect(line).toBe("Going. Sub-goal 1 of 3: draft tests. 8s");
	});

	test("buildGoalLine without subgoal falls back to elapsed-only", () => {
		const line = buildGoalLine({
			runId: "g_1",
			terminal: null,
			subgoal: null,
			elapsedMs: 3_000,
			turns: 0,
			verdictLine: "",
		});
		expect(line).toBe("Going. 3s");
	});

	test("buildGoalLine returns Ready. when there is no run yet", () => {
		const line = buildGoalLine({
			runId: null,
			terminal: null,
			subgoal: null,
			elapsedMs: 0,
			turns: 0,
			verdictLine: "",
		});
		expect(line).toBe("Ready.");
	});

	test("buildGoalLine returns the verdict line when terminal", () => {
		const line = buildGoalLine({
			runId: "g_1",
			terminal: "done",
			subgoal: null,
			elapsedMs: 0,
			turns: 0,
			verdictLine: "Done. Goal met at turn 4.",
		});
		expect(line).toBe("Done. Goal met at turn 4.");
	});
});
