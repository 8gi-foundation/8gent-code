/**
 * Tests for DecisionAuditStore (issue #2756 step 3).
 * Covers: append + read back, chain linkage, verifyChain on a clean log,
 * tamper detection (edit / interior delete / reorder), tail-truncation
 * anchoring, query filters, validation, shared-store wrappers.
 */

import { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { removeDbFiles } from "../../tests/db-files";
import { trackStatements } from "../memory/tracked-db.js";
import { DecisionAuditStore, GENESIS_HASH } from "./decision-store.js";
import {
	getDecisionAuditStore,
	logToolDecision,
	queryToolDecisions,
	resetDecisionAuditStore,
	verifyDecisionChain,
} from "./index.js";
import type { LogDecisionInput } from "./types.js";

let store: DecisionAuditStore;
let dbPath: string;

function tmpDb(): string {
	return join(
		tmpdir(),
		`decision-audit-test-${Date.now()}-${Math.random().toString(36).slice(2, 8)}.db`,
	);
}

function cleanup(p: string): void {
	removeDbFiles(p);
}

function sample(overrides: Partial<LogDecisionInput> = {}): LogDecisionInput {
	return {
		tool: "write_file",
		actor: "agent",
		requestKind: "fs_write",
		requestDetail: "/workspace/src/index.ts",
		decision: "allow",
		gate: "policy-rules",
		reason: "allowed",
		sessionId: "s_test",
		...overrides,
	};
}

beforeEach(() => {
	dbPath = tmpDb();
	store = new DecisionAuditStore(dbPath);
});

afterEach(() => {
	store.close();
	cleanup(dbPath);
});

describe("DecisionAuditStore", () => {
	it("appends and reads back a decision", () => {
		const entry = store.logDecision(sample());
		expect(entry.seq).toBe(1);
		expect(entry.prevHash).toBe(GENESIS_HASH);
		expect(entry.entryHash).toMatch(/^[0-9a-f]{64}$/);

		const events = store.queryDecisions();
		expect(events.length).toBe(1);
		expect(events[0].tool).toBe("write_file");
		expect(events[0].requestKind).toBe("fs_write");
		expect(events[0].requestDetail).toBe("/workspace/src/index.ts");
		expect(events[0].decision).toBe("allow");
		expect(events[0].gate).toBe("policy-rules");
		expect(events[0].sessionId).toBe("s_test");
		expect(events[0].createdAt).toBeGreaterThan(0);
	});

	it("links each entry to the previous entry's hash", () => {
		const a = store.logDecision(sample());
		const b = store.logDecision(sample({ tool: "read_file", requestKind: "fs_read" }));
		const c = store.logDecision(sample({ decision: "deny", reason: "blocked by rule" }));
		expect(b.seq).toBe(2);
		expect(b.prevHash).toBe(a.entryHash);
		expect(c.seq).toBe(3);
		expect(c.prevHash).toBe(b.entryHash);
		expect(store.head()).toEqual({ seq: 3, entryHash: c.entryHash });
	});

	it("verifies a clean chain", () => {
		for (let i = 0; i < 10; i++) {
			store.logDecision(sample({ requestDetail: `/workspace/file-${i}.ts` }));
		}
		const result = store.verifyChain();
		expect(result.valid).toBe(true);
		if (result.valid) {
			expect(result.entries).toBe(10);
			expect(result.headHash).toBe(store.head()?.entryHash ?? "");
		}
	});

	it("verifies an empty chain as valid with the genesis head", () => {
		const result = store.verifyChain();
		expect(result).toEqual({ valid: true, entries: 0, headHash: GENESIS_HASH });
	});

	it("detects an edited entry", () => {
		store.logDecision(sample());
		store.logDecision(sample({ decision: "deny", reason: "blocked" }));
		store.logDecision(sample());

		// Attacker flips the deny at seq 2 into an allow behind the store's back.
		const raw = trackStatements(new Database(dbPath));
		raw
			.prepare(
				"UPDATE policy_decision_log SET decision = 'allow', reason = 'allowed' WHERE seq = 2",
			)
			.run();
		raw.close();

		const result = store.verifyChain();
		expect(result.valid).toBe(false);
		if (!result.valid) {
			expect(result.brokenAtSeq).toBe(2);
			expect(result.reason).toContain("hash mismatch");
		}
	});

	it("detects a deleted interior entry", () => {
		for (let i = 0; i < 4; i++) store.logDecision(sample());

		const raw = trackStatements(new Database(dbPath));
		raw.prepare("DELETE FROM policy_decision_log WHERE seq = 2").run();
		raw.close();

		const result = store.verifyChain();
		expect(result.valid).toBe(false);
		if (!result.valid) {
			expect(result.brokenAtSeq).toBe(3);
			expect(result.reason).toContain("sequence gap");
		}
	});

	it("detects a forged entry whose prev_hash does not link", () => {
		store.logDecision(sample());
		store.logDecision(sample());

		// Attacker rewrites seq 2 wholesale with a self-consistent hash but a
		// prev_hash that does not point at seq 1.
		const raw = trackStatements(new Database(dbPath));
		raw.prepare("UPDATE policy_decision_log SET prev_hash = ? WHERE seq = 2").run("f".repeat(64));
		raw.close();

		const result = store.verifyChain();
		expect(result.valid).toBe(false);
		if (!result.valid) {
			expect(result.brokenAtSeq).toBe(2);
			expect(result.reason).toContain("broken link");
		}
	});

	it("tail truncation is invisible to verifyChain but visible via head anchoring", () => {
		store.logDecision(sample());
		store.logDecision(sample());
		const anchoredHead = store.head();

		// Attacker drops the newest entry. The remaining prefix is a valid
		// chain, which is exactly why the head must be anchored externally.
		const raw = trackStatements(new Database(dbPath));
		raw.prepare("DELETE FROM policy_decision_log WHERE seq = 2").run();
		raw.close();

		const result = store.verifyChain();
		expect(result.valid).toBe(true);
		expect(store.head()?.entryHash).not.toBe(anchoredHead?.entryHash);
	});

	it("queries with filters composed as AND", () => {
		store.logDecision(sample({ tool: "read_file", requestKind: "fs_read" }));
		store.logDecision(
			sample({ tool: "run_command", requestKind: "exec", decision: "deny", reason: "rm blocked" }),
		);
		store.logDecision(sample({ tool: "run_command", requestKind: "exec", sessionId: "s_other" }));

		expect(store.queryDecisions({ tool: "run_command" }).length).toBe(2);
		expect(store.queryDecisions({ decision: "deny" }).length).toBe(1);
		expect(store.queryDecisions({ tool: "run_command", sessionId: "s_other" }).length).toBe(1);
		expect(store.queryDecisions({ actor: "agent" }).length).toBe(3);
		expect(store.queryDecisions({ limit: 2 }).length).toBe(2);
		// Newest first.
		expect(store.queryDecisions()[0].seq).toBe(3);
	});

	it("rejects invalid input", () => {
		expect(() => store.logDecision(sample({ tool: "" }))).toThrow("tool is required");
		expect(() => store.logDecision(sample({ reason: "" }))).toThrow("reason is required");
		expect(() => store.logDecision(sample({ decision: "maybe" as unknown as "allow" }))).toThrow(
			"invalid decision",
		);
		expect(() =>
			store.logDecision(sample({ requestKind: "teleport" as unknown as "exec" })),
		).toThrow("invalid requestKind");
		expect(() => store.logDecision(sample({ gate: "vibes" as unknown as "policy-rules" }))).toThrow(
			"invalid gate",
		);
		expect(store.count()).toBe(0);
	});
});

describe("shared decision store wrappers", () => {
	let sharedPath: string;

	beforeEach(() => {
		sharedPath = tmpDb();
		resetDecisionAuditStore();
		getDecisionAuditStore(sharedPath);
	});

	afterEach(() => {
		resetDecisionAuditStore();
		cleanup(sharedPath);
	});

	it("logToolDecision / queryToolDecisions / verifyDecisionChain use one chain", () => {
		logToolDecision(sample());
		logToolDecision(sample({ decision: "deny", reason: "nope" }));

		const events = queryToolDecisions();
		expect(events.length).toBe(2);

		const result = verifyDecisionChain();
		expect(result.valid).toBe(true);
		if (result.valid) expect(result.entries).toBe(2);
	});
});
