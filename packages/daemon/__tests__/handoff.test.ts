/**
 * Tests for the agent handoff protocol (issue #2422).
 *
 * Covers:
 *   - Happy path: executor result flows through unchanged.
 *   - Depth enforcement: nested handoff is rejected before executor runs.
 *   - Timeout: deadline_ms fires when executor hangs.
 *   - Audit: every handoff (success, fail, timeout, reject) is logged.
 *   - Result shape: handoff_id is normalized; duration_ms is filled.
 */

import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { HandoffAuditLog } from "../audit/handoff-log";
import {
	type AgentHandoff,
	type HandoffExecutor,
	type HandoffResult,
	HandoffDispatcher,
	createHandoff,
} from "../handoff";

let tmp: string;
let audit: HandoffAuditLog;

beforeEach(() => {
	tmp = mkdtempSync(join(tmpdir(), "handoff-test-"));
	audit = new HandoffAuditLog(join(tmp, "audit.jsonl"));
});

afterEach(() => {
	rmSync(tmp, { recursive: true, force: true });
});

function makeExecutor(impl: HandoffExecutor): HandoffExecutor {
	return impl;
}

describe("createHandoff", () => {
	it("fills sensible defaults", () => {
		const h = createHandoff({ from: "8EO", to: "8TO", task: "ship it" });
		expect(h.id).toMatch(/^handoff_/);
		expect(h.artifacts).toEqual([]);
		expect(h.priority).toBe("normal");
		expect(h.context_summary).toBe("");
		expect(h.expected_output).toBe("");
	});

	it("preserves caller-supplied fields", () => {
		const h = createHandoff({
			from: "8EO",
			to: "8TO",
			task: "ship it",
			priority: "critical",
			artifacts: ["packages/daemon/handoff.ts"],
			deadline_ms: 1000,
		});
		expect(h.priority).toBe("critical");
		expect(h.artifacts).toEqual(["packages/daemon/handoff.ts"]);
		expect(h.deadline_ms).toBe(1000);
	});
});

describe("HandoffDispatcher - happy path", () => {
	it("returns the executor's result and writes one audit record", async () => {
		const executor = makeExecutor(async (h): Promise<HandoffResult> => ({
			handoff_id: h.id,
			status: "completed",
			output: `done: ${h.task}`,
			artifacts_produced: ["report.md"],
			tokens_used: 42,
			duration_ms: 0,
		}));

		const dispatcher = new HandoffDispatcher({ executor, auditLog: audit });
		const handoff = createHandoff({ from: "8EO", to: "8TO", task: "ship feature" });
		const result = await dispatcher.dispatch(handoff);

		expect(result.status).toBe("completed");
		expect(result.handoff_id).toBe(handoff.id);
		expect(result.output).toBe("done: ship feature");
		expect(result.duration_ms).toBeGreaterThanOrEqual(0);

		const records = audit.query();
		expect(records).toHaveLength(1);
		expect(records[0].depth).toBe(0);
		expect(records[0].parentId).toBeNull();
		expect(records[0].handoff.id).toBe(handoff.id);
		expect(records[0].result.status).toBe("completed");
	});
});

describe("HandoffDispatcher - depth enforcement", () => {
	it("rejects a nested handoff when maxDepth=1 (default)", async () => {
		let executorRunCount = 0;
		const dispatcher = new HandoffDispatcher({
			executor: async (h, _signal) => {
				executorRunCount++;
				if (h.from === "8EO") {
					// First-level handoff. Try to recurse - this must be rejected.
					const nested = createHandoff({
						from: h.to,
						to: "8DO",
						task: "do another thing",
					});
					const nestedResult = await dispatcher.dispatch(nested, { parentId: h.id });
					return {
						handoff_id: h.id,
						status: nestedResult.status === "rejected" ? "completed" : "failed",
						output: `nested status was: ${nestedResult.status}`,
						artifacts_produced: [],
						tokens_used: 1,
						duration_ms: 0,
					};
				}
				return {
					handoff_id: h.id,
					status: "completed",
					output: "should not run",
					artifacts_produced: [],
					tokens_used: 0,
					duration_ms: 0,
				};
			},
			auditLog: audit,
		});

		const handoff = createHandoff({ from: "8EO", to: "8TO", task: "ship feature" });
		const result = await dispatcher.dispatch(handoff);

		expect(result.status).toBe("completed");
		expect(result.output).toBe("nested status was: rejected");
		expect(executorRunCount).toBe(1); // only the first-level executor ran

		const records = audit.query();
		expect(records).toHaveLength(2);
		const nested = records.find((r) => r.depth === 1);
		expect(nested).toBeDefined();
		expect(nested!.result.status).toBe("rejected");
		expect(nested!.parentId).toBe(handoff.id);
		expect(nested!.result.error).toContain("flat dispatch only");
	});

	it("respects custom maxDepth=2 (allows one extra level)", async () => {
		const dispatcher = new HandoffDispatcher({
			maxDepth: 2,
			executor: async (h) => {
				if (h.from === "8EO") {
					const nested = createHandoff({ from: h.to, to: "8DO", task: "depth 2" });
					const nestedResult = await dispatcher.dispatch(nested, { parentId: h.id });
					return {
						handoff_id: h.id,
						status: nestedResult.status,
						output: nestedResult.output,
						artifacts_produced: [],
						tokens_used: 0,
						duration_ms: 0,
					};
				}
				return {
					handoff_id: h.id,
					status: "completed",
					output: "depth 2 ran",
					artifacts_produced: [],
					tokens_used: 0,
					duration_ms: 0,
				};
			},
			auditLog: audit,
		});

		const handoff = createHandoff({ from: "8EO", to: "8TO", task: "go deep" });
		const result = await dispatcher.dispatch(handoff);
		expect(result.status).toBe("completed");
		expect(result.output).toBe("depth 2 ran");
	});
});

describe("HandoffDispatcher - timeout", () => {
	it("synthesizes a timeout result when the executor exceeds deadline_ms", async () => {
		const dispatcher = new HandoffDispatcher({
			defaultTimeoutMs: 50,
			executor: async (_h, signal) => {
				await new Promise<void>((resolve) => {
					const timer = setTimeout(resolve, 5_000);
					signal.addEventListener("abort", () => {
						clearTimeout(timer);
						resolve();
					});
				});
				return {
					handoff_id: "x",
					status: "completed",
					output: "should never see this",
					artifacts_produced: [],
					tokens_used: 0,
					duration_ms: 5_000,
				};
			},
			auditLog: audit,
		});

		const handoff = createHandoff({
			from: "8EO",
			to: "8TO",
			task: "hang",
			deadline_ms: 50,
		});
		const result = await dispatcher.dispatch(handoff);

		expect(result.status).toBe("timeout");
		expect(result.error).toContain("exceeded 50ms");
		expect(result.handoff_id).toBe(handoff.id);

		const records = audit.query();
		expect(records).toHaveLength(1);
		expect(records[0].result.status).toBe("timeout");
	});
});

describe("HandoffDispatcher - executor errors", () => {
	it("captures thrown errors as failed results", async () => {
		const dispatcher = new HandoffDispatcher({
			executor: async () => {
				throw new Error("kaboom");
			},
			auditLog: audit,
		});

		const handoff = createHandoff({ from: "8EO", to: "8TO", task: "boom" });
		const result = await dispatcher.dispatch(handoff);

		expect(result.status).toBe("failed");
		expect(result.error).toBe("kaboom");
		expect(audit.query()[0].result.status).toBe("failed");
	});
});

describe("HandoffAuditLog - query", () => {
	it("filters by from/to/status and respects limit", async () => {
		const dispatcher = new HandoffDispatcher({
			executor: async (h) => ({
				handoff_id: h.id,
				status: h.task.includes("fail") ? "failed" : "completed",
				output: "",
				artifacts_produced: [],
				tokens_used: 0,
				duration_ms: 0,
			}),
			auditLog: audit,
		});

		await dispatcher.dispatch(createHandoff({ from: "8EO", to: "8TO", task: "ok 1" }));
		await dispatcher.dispatch(createHandoff({ from: "8EO", to: "8DO", task: "ok 2" }));
		await dispatcher.dispatch(createHandoff({ from: "8PO", to: "8TO", task: "fail" }));

		expect(audit.query({ from: "8EO" })).toHaveLength(2);
		expect(audit.query({ to: "8TO" })).toHaveLength(2);
		expect(audit.query({ status: "failed" })).toHaveLength(1);
		expect(audit.query({ limit: 1 })).toHaveLength(1);
	});
});
