/**
 * Tests for the V2 wiring helpers shipped in #2345 + #2346:
 *   - useLilEightState pure derivation
 *   - useGitSync.computeGitSync with an injected runner
 *   - activity-rail-derivation pure helpers
 *   - tui-approval-channel + a simulated keypress-driven approval flow
 */
import { describe, expect, test, beforeEach } from "bun:test";

import { deriveLilEightState, _testing } from "../hooks/useLilEightState";
import { computeGitSync, type GitRunner } from "../hooks/useGitSync";
import {
	deriveTools,
	deriveProviders,
	deriveAgents,
	deriveActiveTasks,
	parseToolName,
} from "../lib/activity-rail-derivation";
import {
	registerTuiApprovalHandler,
	requestTuiApproval,
	hasTuiApprovalHandler,
	_resetTuiApprovalChannel,
	type TuiApprovalDecision,
} from "../../../../packages/permissions/tui-approval-channel";

function msg(partial: { role: string; content?: string; toolSuccess?: boolean }) {
	return {
		id: `m-${Math.random().toString(36).slice(2, 8)}`,
		role: partial.role as any,
		content: partial.content ?? "",
		toolSuccess: partial.toolSuccess,
	};
}

describe("deriveLilEightState", () => {
	const baseInput = {
		messages: [] as any[],
		isProcessing: false,
		lastTurnEndedAt: null,
		lastTurnSuccess: null,
		now: 1_000_000,
		idleSinceMs: 0,
	};

	test("idle when nothing is happening", () => {
		expect(deriveLilEightState(baseInput)).toBe("idle");
	});

	test("working while processing with assistant output", () => {
		expect(
			deriveLilEightState({
				...baseInput,
				isProcessing: true,
				messages: [msg({ role: "assistant", content: "thinking..." })],
			}),
		).toBe("working");
	});

	test("thinking when processing but only a tool start exists", () => {
		expect(
			deriveLilEightState({
				...baseInput,
				isProcessing: true,
				messages: [msg({ role: "tool", content: "→ read_file({})" })],
			}),
		).toBe("thinking");
	});

	test("done when last turn ended ok within window", () => {
		expect(
			deriveLilEightState({
				...baseInput,
				lastTurnEndedAt: baseInput.now - 1_000,
				lastTurnSuccess: true,
			}),
		).toBe("done");
	});

	test("done decays to idle outside the window", () => {
		expect(
			deriveLilEightState({
				...baseInput,
				lastTurnEndedAt: baseInput.now - _testing.DONE_WINDOW_MS - 100,
				lastTurnSuccess: true,
			}),
		).toBe("idle");
	});

	test("error when last turn failed within window", () => {
		expect(
			deriveLilEightState({
				...baseInput,
				lastTurnEndedAt: baseInput.now - 2_000,
				lastTurnSuccess: false,
			}),
		).toBe("error");
	});

	test("sleep after long idle window", () => {
		expect(
			deriveLilEightState({
				...baseInput,
				idleSinceMs: _testing.SLEEP_AFTER_MS + 1_000,
			}),
		).toBe("sleep");
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
	});

	test("no-repo when rev-parse fails", async () => {
		const runner = fakeRunner({});
		const r = await computeGitSync("/tmp/notrepo", runner);
		expect(r.status).toBe("no-repo");
	});
});

describe("activity-rail-derivation", () => {
	test("parseToolName extracts name from arrow prefix", () => {
		expect(parseToolName("→ read_file({})")).toBe("read_file");
		expect(parseToolName("> patch(input)")).toBe("patch");
		expect(parseToolName("nope")).toBe(null);
	});

	test("deriveTools picks last 5 tool messages newest-first", () => {
		const messages = [
			msg({ role: "user", content: "hi" }),
			msg({ role: "tool", content: "→ a({})", toolSuccess: true }),
			msg({ role: "tool", content: "→ b({})", toolSuccess: false }),
			msg({ role: "tool", content: "→ c({})" }),
		] as any;
		const tools = deriveTools(messages, "c", 5);
		expect(tools.map((t) => t.name)).toEqual(["c", "b", "a"]);
		expect(tools[0].state).toBe("running");
		expect(tools[1].state).toBe("fail");
		expect(tools[2].state).toBe("ok");
	});

	test("deriveProviders fmts latency and respects tier order", () => {
		const rows = deriveProviders({
			primary: { name: "ollama:eight", latencyMs: 42 },
			fallback: { name: "openrouter:free", latencyMs: 1200 },
			offline: { name: "deepseek-v4-flash" },
		});
		expect(rows.map((r) => r.state)).toEqual(["local", "fallback", "offline"]);
		expect(rows[0].latency).toBe("42ms");
		expect(rows[2].latency).toBe("—");
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

	test("deriveActiveTasks surfaces in-progress kanban or active tool", () => {
		expect(deriveActiveTasks(null, null, false)).toEqual([]);
		expect(deriveActiveTasks(null, "read_file", true)).toEqual([
			{ id: "tool-active", label: "tool: read_file", progress: 50 },
		]);
		expect(
			deriveActiveTasks(
				{ inProgress: [{ id: "k1", description: "scaffold" }], ready: [] },
				"read_file",
				true,
			),
		).toEqual([{ id: "k1", label: "scaffold", progress: 50 }]);
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
