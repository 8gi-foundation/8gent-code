/**
 * TurnJournal tests.
 *
 * Issue: 8gi-foundation/8gent-code#2470.
 *
 * Concept extracted from StartupHakk/OpenMonoAgent under CleanRoomPort
 * rules; no AGPL source copied. Behaviour rebuilt from the issue spec.
 */

import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { createHash } from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { TurnJournal, type TurnRecord } from "../turn-journal";

let tmpRoot: string;
let dataDir: string;

function makeRecord(overrides: Partial<TurnRecord> = {}): TurnRecord {
	const now = new Date().toISOString();
	return {
		sessionId: "session-a",
		turnIndex: 0,
		startedAt: now,
		finishedAt: now,
		input: { role: "user", content: "hello" },
		systemPromptHash: "deadbeef",
		systemPromptLength: 100,
		toolCalls: [],
		modelOutput: { content: "hi", tokens: { in: 10, out: 5, total: 15 } },
		latencyMs: 42,
		status: "ok",
		...overrides,
	};
}

beforeEach(() => {
	tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "turn-journal-test-"));
	dataDir = path.join(tmpRoot, "turns");
});

afterEach(() => {
	try {
		fs.rmSync(tmpRoot, { recursive: true, force: true });
	} catch {
		/* ignore */
	}
});

// ---- AC 1: one JSON file per turn at documented path --------------------

describe("TurnJournal — file layout", () => {
	it("writes a single JSON file at {dataDir}/{sessionId}/{turnIndex}.json", async () => {
		const j = new TurnJournal("session-a", dataDir);
		await j.write(makeRecord({ turnIndex: 0 }));
		const expected = path.join(dataDir, "session-a", "0.json");
		expect(fs.existsSync(expected)).toBe(true);
		const parsed = JSON.parse(fs.readFileSync(expected, "utf8"));
		expect(parsed.turnIndex).toBe(0);
		expect(parsed.sessionId).toBe("session-a");
	});
});

// ---- AC 2: read(sessionId, N) returns Nth turn full record --------------

describe("TurnJournal — read", () => {
	it("read(sessionId, 3) returns the 3rd turn record", async () => {
		const j = new TurnJournal("session-a", dataDir);
		for (let i = 0; i <= 4; i++) {
			await j.write(makeRecord({ turnIndex: i, modelOutput: { content: `turn-${i}`, tokens: { in: 1, out: 1, total: 2 } } }));
		}
		const rec = await j.read("session-a", 3);
		expect(rec).not.toBeNull();
		expect(rec?.turnIndex).toBe(3);
		expect(rec?.modelOutput.content).toBe("turn-3");
	});

	it("returns null when the turn does not exist", async () => {
		const j = new TurnJournal("session-a", dataDir);
		const rec = await j.read("session-a", 99);
		expect(rec).toBeNull();
	});
});

// ---- AC 3: list returns ascending indices --------------------------------

describe("TurnJournal — list", () => {
	it("list(sessionId) returns turn indices in ascending order", async () => {
		const j = new TurnJournal("session-a", dataDir);
		// Write out-of-order to prove list sorts.
		for (const i of [2, 0, 4, 1, 3]) {
			await j.write(makeRecord({ turnIndex: i }));
		}
		const indices = await j.list("session-a");
		expect(indices).toEqual([0, 1, 2, 3, 4]);
	});

	it("returns empty array when the session has no turns yet", async () => {
		const j = new TurnJournal("session-a", dataDir);
		const indices = await j.list("session-empty");
		expect(indices).toEqual([]);
	});
});

// ---- AC 4: system prompt is hashed, not stored full-text -----------------

describe("TurnJournal — system prompt hashing", () => {
	it("never persists the full system prompt; only hash + length", async () => {
		const j = new TurnJournal("session-a", dataDir);
		const bigPrompt = "SECRET-PROMPT-MARKER-".repeat(5000);
		const { hash, length } = TurnJournal.hashSystemPrompt(bigPrompt);
		expect(hash).toBe(createHash("sha256").update(bigPrompt, "utf8").digest("hex"));
		expect(length).toBe(bigPrompt.length);
		await j.write(
			makeRecord({ systemPromptHash: hash, systemPromptLength: length }),
		);
		const onDisk = fs.readFileSync(path.join(dataDir, "session-a", "0.json"), "utf8");
		expect(onDisk.includes("SECRET-PROMPT-MARKER")).toBe(false);
		expect(onDisk.includes(hash)).toBe(true);
	});
});

// ---- AC 5: tool result preview capped at 1KB, ARTIFACT chip over -------

describe("TurnJournal — tool result preview cap", () => {
	it("clampToolPreview returns input unchanged when <= 1KB", () => {
		const small = "x".repeat(500);
		expect(TurnJournal.clampToolPreview(small)).toBe(small);
	});

	it("clampToolPreview returns an [ARTIFACT hash size] chip when > 1KB", () => {
		const big = "y".repeat(5000);
		const out = TurnJournal.clampToolPreview(big);
		// Format must match ArtifactStore (#2463): [ARTIFACT <hash> <size>]
		expect(out).toMatch(/^\[ARTIFACT [0-9a-f]{8} [0-9.]+(KB|MB)\]$/);
	});

	it("persisted tool calls keep previews <= 1KB on disk", async () => {
		const j = new TurnJournal("session-a", dataDir);
		const big = "z".repeat(8000);
		await j.write(
			makeRecord({
				toolCalls: [
					{
						id: "call-1",
						name: "read_file",
						args: { path: "/x" },
						resultPreview: TurnJournal.clampToolPreview(big),
						durationMs: 12,
						cached: false,
						redacted: false,
					},
				],
			}),
		);
		const parsed = JSON.parse(
			fs.readFileSync(path.join(dataDir, "session-a", "0.json"), "utf8"),
		);
		expect(parsed.toolCalls[0].resultPreview.length).toBeLessThanOrEqual(1024);
		expect(parsed.toolCalls[0].resultPreview).toMatch(/^\[ARTIFACT /);
	});
});

// ---- AC 6: token usage round-trips faithfully ----------------------------

describe("TurnJournal — token usage fidelity", () => {
	it("token usage on disk matches what was written (no rounding)", async () => {
		const j = new TurnJournal("session-a", dataDir);
		await j.write(
			makeRecord({
				modelOutput: {
					content: "ok",
					tokens: { in: 12345, out: 678, total: 13023 },
				},
			}),
		);
		const rec = await j.read("session-a", 0);
		expect(rec?.modelOutput.tokens).toEqual({ in: 12345, out: 678, total: 13023 });
	});
});

// ---- AC 7: parallel sub-agents (different sessionIds) don't collide -----

describe("TurnJournal — concurrent sub-agent isolation", () => {
	it("two sessions in the same dataDir get separate per-session subdirs", async () => {
		const parent = new TurnJournal("parent-1", dataDir);
		const child = new TurnJournal("child-1", dataDir);
		await Promise.all([
			parent.write(makeRecord({ sessionId: "parent-1", turnIndex: 0, modelOutput: { content: "P", tokens: { in: 1, out: 1, total: 2 } } })),
			child.write(makeRecord({ sessionId: "child-1", turnIndex: 0, modelOutput: { content: "C", tokens: { in: 1, out: 1, total: 2 } } })),
		]);
		const pRec = await parent.read("parent-1", 0);
		const cRec = await child.read("child-1", 0);
		expect(pRec?.modelOutput.content).toBe("P");
		expect(cRec?.modelOutput.content).toBe("C");
		expect(fs.existsSync(path.join(dataDir, "parent-1", "0.json"))).toBe(true);
		expect(fs.existsSync(path.join(dataDir, "child-1", "0.json"))).toBe(true);
	});

	it("same sessionId concurrent writes for different turnIndex don't collide", async () => {
		const j = new TurnJournal("session-a", dataDir);
		await Promise.all(
			Array.from({ length: 10 }, (_, i) => j.write(makeRecord({ turnIndex: i }))),
		);
		const indices = await j.list("session-a");
		expect(indices).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 8, 9]);
	});
});

// ---- AC 8: errored turn still writes record with status -----------------

describe("TurnJournal — errored turn", () => {
	it("write accepts status='errored' and persists it", async () => {
		const j = new TurnJournal("session-a", dataDir);
		await j.write(makeRecord({ turnIndex: 0, status: "errored", error: "boom" }));
		const rec = await j.read("session-a", 0);
		expect(rec?.status).toBe("errored");
		expect(rec?.error).toBe("boom");
	});
});
