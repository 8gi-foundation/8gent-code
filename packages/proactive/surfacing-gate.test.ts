/**
 * Surfacing gate tests - deterministic rules paths, the no-model fallback,
 * and the decision log format. No real memory DB, no real notifications:
 * recall/model/notify are injected, the log goes to a temp dir.
 */

import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { evaluate, type Finding, type GateDeps, processFinding } from "./surfacing-gate";

let dir: string;
let logPath: string;
const savedGateEnv = process.env.EIGHT_SURFACING_GATE;

beforeEach(() => {
	dir = mkdtempSync(join(tmpdir(), "surfacing-gate-"));
	logPath = join(dir, "surfacing.jsonl");
	delete process.env.EIGHT_SURFACING_GATE;
});

afterEach(() => {
	rmSync(dir, { recursive: true, force: true });
	if (savedGateEnv === undefined) delete process.env.EIGHT_SURFACING_GATE;
	else process.env.EIGHT_SURFACING_GATE = savedGateEnv;
});

function finding(text: string, extra: Partial<Finding> = {}): Finding {
	return { text, source: "test", sessionId: "s-1", ...extra };
}

function readLog(): Array<Record<string, unknown>> {
	return readFileSync(logPath, "utf8")
		.trim()
		.split("\n")
		.map((line) => JSON.parse(line));
}

describe("severity rule - fires always surface", () => {
	it("surfaces when the producer marks severity=failed", async () => {
		const d = await evaluate(finding("session produced nothing useful", { severity: "failed" }), {
			logPath,
		});
		expect(d.surface).toBe(true);
		expect(d.rule).toBe("severity");
		expect(d.reason).toContain("severity=failed");
	});

	it("surfaces when the producer marks severity=blocked", async () => {
		const d = await evaluate(finding("waiting on a decision", { severity: "blocked" }), {
			logPath,
		});
		expect(d.surface).toBe(true);
		expect(d.rule).toBe("severity");
	});

	it("surfaces on a blocked/failed marker in the text itself", async () => {
		const d = await evaluate(finding("Deploy blocked on missing Convex key"), { logPath });
		expect(d.surface).toBe(true);
		expect(d.rule).toBe("severity");
		expect(d.reason).toContain("blocked");
	});
});

describe("duplicate rule - repeats of recent memory store silently", () => {
	it("stores a finding that duplicates a recent memory entry", async () => {
		const text = "Pattern: read the current file state before editing it";
		const recall = async () => [{ value: "read the current file state before editing" }];
		const d = await evaluate(finding(text), { logPath, recall });
		expect(d.surface).toBe(false);
		expect(d.rule).toBe("duplicate");
		expect(d.reason).toContain("overlap");
	});

	it("does not mark a genuinely novel finding as duplicate", async () => {
		const recall = async () => [{ value: "something entirely unrelated about deployment keys" }];
		const d = await evaluate(finding("new pattern: prefer dedicated file tools over bash cat"), {
			logPath,
			recall,
		});
		expect(d.rule).not.toBe("duplicate");
	});

	it("falls through when recall throws (novelty unknown, rules-only)", async () => {
		const recall = async (): Promise<Array<{ value: string }>> => {
			throw new Error("memory db unavailable");
		};
		const d = await evaluate(finding("benign novel observation about tooling"), {
			logPath,
			recall,
		});
		expect(d.surface).toBe(false);
		expect(d.rule).toBe("default");
	});
});

describe("default rule - store silently is the conservative baseline", () => {
	it("stores a benign novel finding when no model is available", async () => {
		const d = await evaluate(finding("observed that sessions often mix bash and file tools"), {
			logPath,
		});
		expect(d.surface).toBe(false);
		expect(d.rule).toBe("default");
		expect(d.reason).toContain("stored silently");
	});

	it("stores an empty finding with its own reason", async () => {
		const d = await evaluate(finding("   "), { logPath });
		expect(d.surface).toBe(false);
		expect(d.rule).toBe("empty");
	});
});

describe("model pass - ambiguous middle only, conservative on failure", () => {
	const soft = "recommend consolidating the three retry helpers into one";

	it("surfaces when the model answers YES", async () => {
		const d = await evaluate(finding(soft), { logPath, model: async () => "YES" });
		expect(d.surface).toBe(true);
		expect(d.rule).toBe("model");
	});

	it("stores when the model answers NO", async () => {
		const d = await evaluate(finding(soft), { logPath, model: async () => "no, store it" });
		expect(d.surface).toBe(false);
		expect(d.rule).toBe("model");
	});

	it("falls back to store when the model call fails (no model available)", async () => {
		const model = async (): Promise<string> => {
			throw new Error("connection refused");
		};
		const d = await evaluate(finding(soft), { logPath, model });
		expect(d.surface).toBe(false);
		expect(d.rule).toBe("default");
	});

	it("falls back to store on an unparseable model answer", async () => {
		const d = await evaluate(finding(soft), { logPath, model: async () => "perhaps, hard to say" });
		expect(d.surface).toBe(false);
		expect(d.rule).toBe("default");
	});

	it("never invokes the model without a soft signal", async () => {
		let called = 0;
		const model = async () => {
			called++;
			return "YES";
		};
		const d = await evaluate(finding("plain observation with no signal words"), {
			logPath,
			model,
		});
		expect(called).toBe(0);
		expect(d.rule).toBe("default");
	});
});

describe("decision log - every decision explained", () => {
	it("appends one valid JSON line per decision with the full format", async () => {
		const fixed = new Date("2026-08-11T09:00:00.000Z");
		const deps: GateDeps = { logPath, now: () => fixed };
		await evaluate(finding("Deploy failed on the token step", { severity: "failed" }), deps);
		await evaluate(finding("benign novel observation"), deps);

		const lines = readLog();
		expect(lines.length).toBe(2);
		expect(lines[0]).toEqual({
			ts: "2026-08-11T09:00:00.000Z",
			source: "test",
			sessionId: "s-1",
			surface: true,
			rule: "severity",
			reason: lines[0].reason,
			preview: "Deploy failed on the token step",
		});
		expect(typeof lines[0].reason).toBe("string");
		expect((lines[0].reason as string).length).toBeGreaterThan(0);
		expect(lines[1].surface).toBe(false);
		expect(lines[1].rule).toBe("default");
	});

	it("honors EIGHT_DATA_DIR for the default log path (test sandboxing convention)", async () => {
		const saved = process.env.EIGHT_DATA_DIR;
		process.env.EIGHT_DATA_DIR = dir;
		try {
			await evaluate(finding("sandboxed decision"));
			const lines = readFileSync(join(dir, "flow", "surfacing.jsonl"), "utf8").trim().split("\n");
			expect(lines.length).toBe(1);
			expect(JSON.parse(lines[0]).rule).toBe("default");
		} finally {
			if (saved === undefined) delete process.env.EIGHT_DATA_DIR;
			else process.env.EIGHT_DATA_DIR = saved;
		}
	});

	it("truncates the preview to 160 characters", async () => {
		const long = `failed: ${"x".repeat(400)}`;
		await evaluate(finding(long), { logPath });
		const lines = readLog();
		expect((lines[0].preview as string).length).toBe(160);
	});
});

describe("processFinding - flag and routing", () => {
	const noRecall = async (): Promise<Array<{ value: string }>> => [];

	it("returns disabled and does nothing when EIGHT_SURFACING_GATE=0", async () => {
		process.env.EIGHT_SURFACING_GATE = "0";
		let notified = 0;
		const d = await processFinding(finding("failed everywhere", { severity: "failed" }), {
			logPath,
			recall: noRecall,
			notify: async () => {
				notified++;
			},
		});
		expect(d.rule).toBe("disabled");
		expect(d.surface).toBe(false);
		expect(notified).toBe(0);
	});

	it("routes a surfaced finding through the injected notify exactly once", async () => {
		const calls: Array<{ title: string; body: string }> = [];
		const d = await processFinding(finding("Blocked: needs a key rotation decision"), {
			logPath,
			recall: noRecall,
			notify: async (title, body) => {
				calls.push({ title, body });
			},
		});
		expect(d.surface).toBe(true);
		expect(calls.length).toBe(1);
		expect(calls[0].title).toContain("test");
		expect(calls[0].body).toContain("key rotation");
	});

	it("does not notify on a store decision", async () => {
		let notified = 0;
		const d = await processFinding(finding("benign background note"), {
			logPath,
			recall: noRecall,
			notify: async () => {
				notified++;
			},
		});
		expect(d.surface).toBe(false);
		expect(notified).toBe(0);
	});

	it("still returns the decision when notify throws", async () => {
		const d = await processFinding(finding("failed run needs eyes", { severity: "failed" }), {
			logPath,
			recall: noRecall,
			notify: async () => {
				throw new Error("channel down");
			},
		});
		expect(d.surface).toBe(true);
		expect(d.rule).toBe("severity");
	});
});
