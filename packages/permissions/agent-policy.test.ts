import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { AgentPolicyEngine, loadAgentPolicy } from "./agent-policy";

// Isolated tmp dir so the loader does not pick up the user's real
// ~/.8gent/policies. Tests still want the bundled repo policies as a
// fallback, so EIGHT_POLICIES_DIR points at an empty directory.
const TMP_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "agent-policy-test-"));
const POLICIES_DIR = path.join(TMP_DIR, "policies");

beforeAll(() => {
	fs.mkdirSync(POLICIES_DIR, { recursive: true });
	process.env.EIGHT_POLICIES_DIR = POLICIES_DIR;
	process.env.EIGHT_DATA_DIR = TMP_DIR;
});

afterAll(() => {
	process.env.EIGHT_POLICIES_DIR = undefined;
	process.env.EIGHT_DATA_DIR = undefined;
	try {
		fs.rmSync(TMP_DIR, { recursive: true, force: true });
	} catch {}
});

function writePolicy(name: string, body: string): void {
	fs.writeFileSync(path.join(POLICIES_DIR, `${name}.yaml`), body, "utf-8");
}

describe("loadAgentPolicy", () => {
	test("loads a flat policy with no inheritance", () => {
		writePolicy(
			"flat",
			`
version: "1"
agent: flat
permissions:
  tools:
    allow: [a, b]
    deny: [c]
  data:
    read: [foo/**]
    write: [bar/**]
guardrails:
  max_output_tokens: 1024
`.trim(),
		);
		const policy = loadAgentPolicy("flat");
		expect(policy.permissions.tools.allow).toEqual(["a", "b"]);
		expect(policy.permissions.tools.deny).toEqual(["c"]);
		expect(policy.permissions.data.read).toEqual(["foo/**"]);
		expect(policy.guardrails.max_output_tokens).toBe(1024);
	});

	test("resolves single-level inheritance", () => {
		writePolicy(
			"parent",
			`
version: "1"
agent: parent
permissions:
  tools:
    allow: [read]
    deny: [drop_db]
  data:
    deny: [/etc/**]
guardrails:
  max_output_tokens: 4096
`.trim(),
		);
		writePolicy(
			"child",
			`
version: "1"
agent: child
inherit: parent
permissions:
  tools:
    allow: [write]
guardrails:
  max_output_tokens: 1024
`.trim(),
		);
		const policy = loadAgentPolicy("child");
		expect(policy.chain).toEqual(["child", "parent"]);
		// child narrows allow but parent's contributions also accumulate
		expect(policy.permissions.tools.allow).toContain("write");
		expect(policy.permissions.tools.allow).toContain("read");
		// deny is sticky from parent
		expect(policy.permissions.tools.deny).toContain("drop_db");
		expect(policy.permissions.data.deny).toContain("/etc/**");
		// child override wins for scalar guardrails
		expect(policy.guardrails.max_output_tokens).toBe(1024);
	});

	test("rejects inheritance loops", () => {
		writePolicy("loopa", "version: '1'\nagent: loopa\ninherit: loopb\n");
		writePolicy("loopb", "version: '1'\nagent: loopb\ninherit: loopa\n");
		expect(() => loadAgentPolicy("loopa")).toThrow(/loop/);
	});

	test("throws when policy file is missing", () => {
		expect(() => loadAgentPolicy("does-not-exist")).toThrow(/not found/);
	});
});

describe("AgentPolicyEngine.checkAction", () => {
	test("denies tool not in allow list", () => {
		writePolicy(
			"narrow",
			`
version: "1"
agent: narrow
permissions:
  tools:
    allow: [file_read]
`.trim(),
		);
		const engine = AgentPolicyEngine.load("narrow");
		const decision = engine.checkAction({ tool: "shell_exec" });
		expect(decision.allowed).toBe(false);
		if (!decision.allowed) expect(decision.category).toBe("tool_denied");
	});

	test("denies tool in deny list even if allow includes it", () => {
		writePolicy(
			"deny-wins",
			`
version: "1"
agent: deny-wins
permissions:
  tools:
    allow: [shell_exec]
    deny: [shell_exec]
`.trim(),
		);
		const engine = AgentPolicyEngine.load("deny-wins");
		const decision = engine.checkAction({ tool: "shell_exec" });
		expect(decision.allowed).toBe(false);
	});

	test("denies path outside data scope", () => {
		writePolicy(
			"scoped",
			`
version: "1"
agent: scoped
permissions:
  tools:
    allow: [file_read]
  data:
    read: [workspace/**]
    deny: [/etc/**]
`.trim(),
		);
		const engine = AgentPolicyEngine.load("scoped");
		expect(engine.checkAction({ tool: "file_read", path: "/etc/passwd" }).allowed).toBe(false);
		expect(engine.checkAction({ tool: "file_read", path: "workspace/src/a.ts" }).allowed).toBe(
			true,
		);
		expect(engine.checkAction({ tool: "file_read", path: "other/x" }).allowed).toBe(false);
	});

	test("blocks raw-input substrings", () => {
		writePolicy(
			"patterns",
			`
version: "1"
agent: patterns
guardrails:
  blocked_patterns: ["DROP TABLE", "rm -rf /"]
`.trim(),
		);
		const engine = AgentPolicyEngine.load("patterns");
		const decision = engine.checkAction({
			tool: "shell_exec",
			rawInput: "select * from t; drop table users;",
		});
		expect(decision.allowed).toBe(false);
		if (!decision.allowed) expect(decision.category).toBe("blocked_pattern");
	});

	test("flags require_approval tools", () => {
		writePolicy(
			"approval",
			`
version: "1"
agent: approval
permissions:
  tools:
    allow: [send_email]
guardrails:
  require_approval_for: [send_email]
`.trim(),
		);
		const engine = AgentPolicyEngine.load("approval");
		const decision = engine.checkAction({ tool: "send_email" });
		expect(decision.allowed).toBe(false);
		if (!decision.allowed) {
			expect(decision.requiresApproval).toBe(true);
		}
	});
});

describe("AgentPolicyEngine.checkRateLimit", () => {
	test("returns allowed when no limit set", () => {
		writePolicy("no-limit", `version: "1"\nagent: no-limit\n`);
		const engine = AgentPolicyEngine.load("no-limit");
		expect(engine.checkRateLimit("tool_call").allowed).toBe(true);
	});

	test("blocks once per-minute cap is hit", () => {
		writePolicy(
			"rate",
			`
version: "1"
agent: rate
permissions:
  rate_limits:
    tool_calls_per_minute: 2
`.trim(),
		);
		const engine = AgentPolicyEngine.load("rate");
		const now = 1_000_000_000;
		expect(engine.checkRateLimit("tool_call", now).allowed).toBe(true);
		expect(engine.checkRateLimit("tool_call", now + 1).allowed).toBe(true);
		const third = engine.checkRateLimit("tool_call", now + 2);
		expect(third.allowed).toBe(false);
		if (!third.allowed) expect(third.category).toBe("rate_limited");
		// new window resets
		expect(engine.checkRateLimit("tool_call", now + 60_001).allowed).toBe(true);
	});
});
