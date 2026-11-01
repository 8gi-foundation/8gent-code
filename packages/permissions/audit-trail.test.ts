/**
 * Tests for the tamper-evident decision audit trail wired into
 * evaluateToolCall (issue #2756 step 3).
 *
 * Every tool-call decision - allow or deny, from either gate - must land in
 * the @8gent/audit hash chain with a secret-scrubbed request detail. A trail
 * that cannot be written is warn-and-continue by default and a hard deny
 * under AUDIT_STRICT=1.
 */

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
	getDecisionAuditStore,
	queryToolDecisions,
	resetDecisionAuditStore,
	verifyDecisionChain,
} from "@8gent/audit";
import { evaluateToolCall } from "./policy-engine";

const WORKSPACE = fs.mkdtempSync(path.join(os.tmpdir(), "audit-trail-workspace-"));
let trailDb: string;

beforeAll(() => {
	fs.writeFileSync(path.join(WORKSPACE, "hello.txt"), "hi");
});

afterAll(() => {
	fs.rmSync(WORKSPACE, { recursive: true, force: true });
});

beforeEach(() => {
	trailDb = path.join(
		os.tmpdir(),
		`audit-trail-test-${Date.now()}-${Math.random().toString(36).slice(2, 8)}.db`,
	);
	resetDecisionAuditStore();
	getDecisionAuditStore(trailDb);
});

afterEach(() => {
	resetDecisionAuditStore();
	for (const ext of ["", "-wal", "-shm"]) {
		const p = trailDb + ext;
		if (fs.existsSync(p)) {
			try {
				fs.unlinkSync(p);
			} catch {
				/* best effort */
			}
		}
	}
	delete process.env.AUDIT_STRICT;
	delete process.env.EIGHT_DATA_DIR;
});

const opts = { workingDirectory: WORKSPACE };

describe("evaluateToolCall audit trail", () => {
	test("an allowed fs_read is recorded with gate policy-rules", () => {
		const target = path.join(WORKSPACE, "hello.txt");
		const decision = evaluateToolCall(
			"read_file",
			{ kind: "fs_read", path: target },
			{ ...opts, sessionId: "s_audit", agentId: "coder-1" },
		);
		expect(decision.allowed).toBe(true);

		const events = queryToolDecisions({ tool: "read_file" });
		expect(events.length).toBe(1);
		expect(events[0].decision).toBe("allow");
		expect(events[0].gate).toBe("policy-rules");
		expect(events[0].requestKind).toBe("fs_read");
		expect(events[0].requestDetail).toBe(target);
		expect(events[0].sessionId).toBe("s_audit");
		expect(events[0].actor).toBe("coder-1");
	});

	test("a capability-manifest deny is recorded with gate capability-manifest", () => {
		// No manifest registered for this tool: structural deny before any rule.
		const decision = evaluateToolCall(
			"mystery_tool",
			{ kind: "fs_read", path: path.join(WORKSPACE, "hello.txt") },
			opts,
		);
		expect(decision.allowed).toBe(false);

		const events = queryToolDecisions({ tool: "mystery_tool" });
		expect(events.length).toBe(1);
		expect(events[0].decision).toBe("deny");
		expect(events[0].gate).toBe("capability-manifest");
		if (!decision.allowed) expect(events[0].reason).toBe(decision.reason);
	});

	test("a policy-rules deny is recorded with the rule's reason", () => {
		const decision = evaluateToolCall("run_command", { kind: "exec", command: "rm -rf /" }, opts);
		expect(decision.allowed).toBe(false);

		const events = queryToolDecisions({ tool: "run_command", decision: "deny" });
		expect(events.length).toBe(1);
		expect(events[0].gate).toBe("policy-rules");
		expect(events[0].requestKind).toBe("exec");
	});

	test("secrets in the request detail are scrubbed before persisting", () => {
		const secret = `sk-${"a1B2c3D4e5".repeat(3)}`;
		evaluateToolCall(
			"run_command",
			{ kind: "exec", command: `curl -H "Authorization: ${secret}" https://example.com` },
			opts,
		);

		const events = queryToolDecisions({ tool: "run_command" });
		expect(events.length).toBe(1);
		expect(events[0].requestDetail).not.toContain(secret);
		expect(events[0].requestDetail).toContain("[REDACTED:openai-key]");
	});

	test("the recorded trail verifies as an unbroken chain", () => {
		for (let i = 0; i < 5; i++) {
			evaluateToolCall(
				"read_file",
				{ kind: "fs_read", path: path.join(WORKSPACE, "hello.txt") },
				opts,
			);
		}
		const result = verifyDecisionChain();
		expect(result.valid).toBe(true);
		if (result.valid) expect(result.entries).toBe(5);
	});

	test("an unwritable trail does not change the decision by default", () => {
		// Point the shared store's default resolution at a FILE so the audit
		// dir mkdir fails, then drop the healthy shared handle.
		const blocker = path.join(
			os.tmpdir(),
			`audit-trail-blocker-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
		);
		fs.writeFileSync(blocker, "not a directory");
		process.env.EIGHT_DATA_DIR = blocker;
		resetDecisionAuditStore();

		try {
			const decision = evaluateToolCall(
				"read_file",
				{ kind: "fs_read", path: path.join(WORKSPACE, "hello.txt") },
				opts,
			);
			expect(decision.allowed).toBe(true);
		} finally {
			fs.rmSync(blocker, { force: true });
		}
	});

	test("AUDIT_STRICT=1 fails closed when the trail cannot be written", () => {
		const blocker = path.join(
			os.tmpdir(),
			`audit-trail-blocker-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
		);
		fs.writeFileSync(blocker, "not a directory");
		process.env.EIGHT_DATA_DIR = blocker;
		process.env.AUDIT_STRICT = "1";
		resetDecisionAuditStore();

		try {
			const decision = evaluateToolCall(
				"read_file",
				{ kind: "fs_read", path: path.join(WORKSPACE, "hello.txt") },
				opts,
			);
			expect(decision.allowed).toBe(false);
			if (!decision.allowed) expect(decision.reason).toContain("audit trail unavailable");
		} finally {
			fs.rmSync(blocker, { force: true });
		}
	});
});
