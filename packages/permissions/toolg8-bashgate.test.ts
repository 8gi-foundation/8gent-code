/**
 * Integration tests: bash segment gate wired into the LIVE policy chokepoint
 * (issue #2782, wiring for #2466).
 *
 * The parser (packages/tools/bash-parser.ts) and gateBashCommand
 * (packages/tools/bash-tool.ts) were built and unit-tested in PR #2483 but
 * had ZERO importers - the production path
 * ToolExecutor.executeRaw -> ToolG8.gate -> evaluatePolicy evaluated only the
 * raw whole command string. These tests prove, at both the ToolG8 level and
 * the real ToolExecutor.execute path, that:
 *
 *   1. "echo hi && <denied>" is blocked (compound evasion)
 *   2. "<denied>" inside $() or backticks is blocked (subshell evasion)
 *   3. "ls > /etc/passwd" trips write_file policy (redirection = write capability)
 *   4. The existing allow set still passes (zero regression)
 *   5. A parser fault falls back to whole-string evaluation and is audited
 *      (fail-safe, never silent, never weaker than the legacy check)
 *
 * Deny fixtures use the distinctive token "zzz-denied-bin" with a starts_with
 * condition ON PURPOSE: a whole-string `contains` rule would already catch the
 * compound/subshell cases, which would prove nothing about segment wiring.
 * starts_with only matches when the SEGMENT is evaluated on its own.
 *
 * NOTE: destructive literals follow the bash-parser.test.ts placeholder
 * convention; the gate is content-agnostic.
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { cleanupTempDirs, tempDir } from "../../tests/temp-dirs";
import { ToolExecutor } from "../eight/tools";
import { addPolicy, loadPolicies } from "./policy-engine";
import { ToolG8, getAuditPath } from "./toolg8";

// Remove the temp dirs tempDir() has recorded, this file's included (#3285).
afterAll(cleanupTempDirs);

function lastAuditEntry(): Record<string, any> {
	// getAuditPath() is the path toolg8 resolved at ITS module load, so this
	// stays correct even when another test file mutates EIGHT_DATA_DIR.
	const lines = readFileSync(getAuditPath(), "utf-8").trim().split("\n");
	return JSON.parse(lines[lines.length - 1]);
}

const savedWorkspaceRoot = process.env.EIGHT_WORKSPACE_ROOT;
const savedHeadless = process.env.EIGHT_HEADLESS;

beforeAll(() => {
	// Deterministic environment: no workspace-boundary interference, and the
	// permission manager must never open an interactive prompt under test.
	delete process.env.EIGHT_WORKSPACE_ROOT;
	process.env.EIGHT_HEADLESS = "1";

	// Reset to shipped policies, then layer the test deny fixtures on top.
	loadPolicies();
	addPolicy({
		name: "test-bashgate-deny-segment",
		action: "run_command",
		condition: "command starts_with zzz-denied-bin",
		decision: "block",
		message: "test fixture: zzz-denied-bin is blocked",
	});
	addPolicy({
		name: "test-bashgate-deny-etc-write",
		action: "write_file",
		condition: "path starts_with /etc/",
		decision: "block",
		message: "test fixture: writes under /etc/ are blocked",
	});
});

afterAll(() => {
	// Drop the runtime test rules so no other test file inherits them.
	loadPolicies();
	if (savedWorkspaceRoot === undefined) delete process.env.EIGHT_WORKSPACE_ROOT;
	else process.env.EIGHT_WORKSPACE_ROOT = savedWorkspaceRoot;
	if (savedHeadless === undefined) delete process.env.EIGHT_HEADLESS;
	else process.env.EIGHT_HEADLESS = savedHeadless;
});

// ============================================
// ToolG8.gate level (the policy chokepoint)
// ============================================

describe("ToolG8.gate - per-segment bash evaluation", () => {
	const g8 = ToolG8.instance();

	test("sanity: the deny fixture blocks the bare command via the whole-string path", () => {
		const r = g8.gate("primary", "run_command", { command: "zzz-denied-bin --fire" });
		expect(r.allowed).toBe(false);
	});

	test("sanity: the fixture does NOT match the compound string as a whole (segment wiring is what blocks it)", () => {
		// starts_with cannot match "echo hi && zzz-denied-bin ..." as one string.
		// Proven via the parser-fault fallback below, where whole-string-only
		// evaluation ALLOWS this exact command.
		const r = g8.gate("primary", "run_command", { command: "echo hi && zzz-denied-bin --fire" });
		expect(r.allowed).toBe(false);
		expect(r.reason).toContain("[bash-segment]");
		expect(r.reason).toContain("zzz-denied-bin");
	});

	test("compound &&: denied second segment blocks the whole command", () => {
		const r = g8.gate("primary", "run_command", { command: "echo hi && zzz-denied-bin --fire" });
		expect(r.allowed).toBe(false);
	});

	test("compound ; and ||: denied segment blocks the whole command", () => {
		expect(g8.gate("primary", "run_command", { command: "echo hi ; zzz-denied-bin" }).allowed).toBe(
			false,
		);
		expect(g8.gate("primary", "run_command", { command: "true || zzz-denied-bin" }).allowed).toBe(
			false,
		);
	});

	test("subshell $(): denied command inside substitution is blocked", () => {
		const r = g8.gate("primary", "run_command", { command: "echo $(zzz-denied-bin --fire)" });
		expect(r.allowed).toBe(false);
		expect(r.reason).toContain("zzz-denied-bin");
	});

	test("subshell backticks: denied command inside substitution is blocked", () => {
		const r = g8.gate("primary", "run_command", { command: "echo `zzz-denied-bin --fire`" });
		expect(r.allowed).toBe(false);
	});

	test("nested subshell: denied command two levels deep is blocked", () => {
		const r = g8.gate("primary", "run_command", {
			command: "echo $(echo $(zzz-denied-bin --fire))",
		});
		expect(r.allowed).toBe(false);
	});

	test("redirection > to a protected path trips write_file policy", () => {
		const r = g8.gate("primary", "run_command", { command: "ls > /etc/passwd" });
		expect(r.allowed).toBe(false);
		expect(r.reason).toContain("/etc/");
	});

	test("redirection >> (append) to a protected path is also a write_file", () => {
		const r = g8.gate("primary", "run_command", { command: "echo pwned >> /etc/hosts" });
		expect(r.allowed).toBe(false);
	});

	test("redirection to a credential basename trips the path guard", () => {
		const r = g8.gate("primary", "run_command", { command: "echo x > id_rsa" });
		expect(r.allowed).toBe(false);
		expect(r.reason).toContain("protected credential file");
	});

	test("whole-string deny still fires and its reason wins (legacy path intact)", () => {
		const r = g8.gate("primary", "run_command", { command: "sudo dd if=/dev/zero of=/dev/sda" });
		expect(r.allowed).toBe(false);
		// Whole-string reason, not the [bash-segment] prefix.
		expect(r.reason).not.toContain("[bash-segment]");
	});

	// Zero regression: the existing allow set must keep passing.
	const stillAllowed = [
		"ls -la",
		"git status",
		"echo hi",
		"cat foo.txt | grep bar | wc -l",
		"bun test 2>&1",
		"ls > out.txt",
		"git commit -m 'fix: handle a && b in strings'",
		"echo $(date)",
	];
	for (const cmd of stillAllowed) {
		test(`zero regression - still allowed: ${cmd}`, () => {
			const r = g8.gate("primary", "run_command", { command: cmd });
			expect(r.allowed).toBe(true);
		});
	}

	test("empty command is allowed (caller no-op contract)", () => {
		expect(g8.gate("primary", "run_command", { command: "   " }).allowed).toBe(true);
	});
});

// ============================================
// Audit JSONL - segment reason + capabilities
// ============================================

describe("ToolG8 audit - bash trace lands in toolg8.jsonl", () => {
	const g8 = ToolG8.instance();

	test("denied compound command writes segment reason + capabilities", () => {
		g8.gate("primary", "run_command", { command: "echo hi && zzz-denied-bin --fire" });
		const entry = lastAuditEntry();
		expect(entry.allowed).toBe(false);
		expect(entry.action).toBe("run_command");
		expect(entry.bash).toBeDefined();
		expect(entry.bash.denied).toBe(true);
		expect(entry.bash.reason).toContain("zzz-denied-bin");
		expect(entry.bash.capabilityCount).toBe(2);
		const kinds = entry.bash.capabilities.map((c: any) => c.kind);
		expect(kinds).toEqual(["run_command", "run_command"]);
		expect(entry.bash.capabilities[1].command).toContain("zzz-denied-bin");
		expect(entry.bash.capabilities[1].source).toBe("segment");
	});

	test("redirection deny records the write_file capability with its path", () => {
		g8.gate("primary", "run_command", { command: "ls > /etc/passwd" });
		const entry = lastAuditEntry();
		expect(entry.bash.denied).toBe(true);
		const write = entry.bash.capabilities.find((c: any) => c.kind === "write_file");
		expect(write).toBeDefined();
		expect(write.path).toBe("/etc/passwd");
		expect(write.source).toBe("redirection");
	});

	test("allowed command still records its capability trace", () => {
		g8.gate("primary", "run_command", { command: "cat a.txt | wc -l" });
		const entry = lastAuditEntry();
		expect(entry.allowed).toBe(true);
		expect(entry.bash.denied).toBe(false);
		expect(entry.bash.capabilityCount).toBe(2);
	});
});

// ============================================
// Parser fault - fail-safe fallback
// ============================================

describe("ToolG8 - parser fault falls back to whole-string evaluation", () => {
	const g8 = ToolG8.instance();

	test("parser throw: whole-string check remains authoritative and the fault is audited", () => {
		g8._setBashGateForTest(() => {
			throw new Error("simulated parser fault");
		});
		try {
			// Whole-string catches the bare denied command even without segments.
			const denied = g8.gate("primary", "run_command", { command: "zzz-denied-bin --fire" });
			expect(denied.allowed).toBe(false);

			// Whole-string alone cannot see the compound evasion - this is exactly
			// the pre-wiring behavior the fallback preserves (never weaker, never
			// stronger than legacy when the parser is down). It also proves the
			// segment gate, when healthy, is what blocks this command.
			const fallback = g8.gate("primary", "run_command", {
				command: "echo hi && zzz-denied-bin --fire",
			});
			expect(fallback.allowed).toBe(true);

			// The fault is never silent: parserError lands in the audit entry.
			const entry = lastAuditEntry();
			expect(entry.bash.parserError).toContain("simulated parser fault");
			expect(entry.bash.denied).toBe(false);
		} finally {
			g8._setBashGateForTest(null);
		}

		// Gate restored: the compound evasion is blocked again.
		const restored = g8.gate("primary", "run_command", {
			command: "echo hi && zzz-denied-bin --fire",
		});
		expect(restored.allowed).toBe(false);
	});
});

// ============================================
// ToolExecutor.execute - the real execution seam
// ============================================

describe("ToolExecutor.execute - bash gate at the production chokepoint", () => {
	test("compound evasion is [TOOLG8 BLOCKED] and nothing executes", async () => {
		const dir = tempDir("bashgate-exec-");
		const exec = new ToolExecutor(dir, "primary");
		const marker = join(dir, "leaked.txt");

		const result = await exec.execute("run_command", {
			command: `echo hi > ${marker} && zzz-denied-bin --fire`,
		});

		expect(result).toContain("[TOOLG8 BLOCKED]");
		expect(result).toContain("zzz-denied-bin");
		// The allowed first segment never ran either - deny blocks the whole command.
		expect(existsSync(marker)).toBe(false);
	});

	test("subshell evasion is [TOOLG8 BLOCKED] before any spawn", async () => {
		const dir = tempDir("bashgate-exec-");
		const exec = new ToolExecutor(dir, "primary");

		const result = await exec.execute("run_command", {
			command: "echo $(zzz-denied-bin --fire)",
		});

		expect(result).toContain("[TOOLG8 BLOCKED]");
	});

	test("redirection to /etc/passwd is [TOOLG8 BLOCKED] as a write_file capability", async () => {
		const dir = tempDir("bashgate-exec-");
		const exec = new ToolExecutor(dir, "primary");

		// Pre-wiring, this passed the whole-string run_command check AND
		// sanitizeShellCommand (redirects are legal) and reached the shell.
		const result = await exec.execute("run_command", { command: "ls > /etc/passwd" });

		expect(result).toContain("[TOOLG8 BLOCKED]");
		expect(result).toContain("/etc/");
	});

	test("zero regression: a benign command still executes end-to-end", async () => {
		const dir = tempDir("bashgate-exec-");
		const exec = new ToolExecutor(dir, "primary");

		const result = await exec.execute("run_command", { command: "echo bashgate-ok" });

		expect(result).toContain("bashgate-ok");
		expect(result).not.toContain("[TOOLG8 BLOCKED]");
	});

	test("zero regression: a benign redirect inside the workspace still executes", async () => {
		const dir = tempDir("bashgate-exec-");
		const exec = new ToolExecutor(dir, "primary");
		const out = join(dir, "out.txt");

		const result = await exec.execute("run_command", { command: `echo content > ${out}` });

		expect(result).not.toContain("[TOOLG8 BLOCKED]");
		expect(existsSync(out)).toBe(true);
	});
});
