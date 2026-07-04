/**
 * RED-TEAM: maker-checker enforcement at the tool-execution chokepoint.
 *
 * These tests prove that a destructive tool (rm via run_command, git_push)
 * invoked in an UNATTENDED/autonomous context is hard-blocked unless an
 * APPROVED CheckerDecision exists, and that interactive flows are untouched.
 *
 * Without the enforcement wired into ToolExecutor.executeRaw, the integration
 * cases below (which assert the "[MAKER-CHECKER BLOCKED]" marker) FAIL — the rm
 * would flow straight through to execution. With enforcement, they PASS.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ToolExecutor } from "../eight/tools";
import {
	MakerCheckerBlockedError,
	assertMakerCheckerApproved,
	classifyToolAction,
	getMakerCheckerStore,
	resetMakerCheckerEnforcer,
} from "./maker-checker-enforcer";

beforeEach(() => {
	resetMakerCheckerEnforcer();
	delete process.env.EIGHT_ENFORCE_CHECKER;
});

afterEach(() => {
	delete process.env.EIGHT_ENFORCE_CHECKER;
});

describe("classifyToolAction", () => {
	test("classifies a destructive rm run_command", () => {
		const c = classifyToolAction("run_command", { command: "rm -rf /tmp/victim" });
		expect(c).not.toBeNull();
		expect(c!.action.startsWith("shell:")).toBe(true);
		expect(c!.risk).toBe("destructive");
	});

	test("does not classify a benign command", () => {
		expect(classifyToolAction("run_command", { command: "ls -la" })).toBeNull();
		expect(classifyToolAction("read_file", { path: "x.ts" })).toBeNull();
	});

	test("classifies git_push to main as DESTRUCTIVE, feature as RISKY", () => {
		expect(classifyToolAction("git_push", { branch: "main" })!.risk).toBe("destructive");
		expect(classifyToolAction("git_push", { branch: "feat/x" })!.risk).toBe("risky");
	});

	test("classifies deploy / credential / infinite tools", () => {
		expect(classifyToolAction("vercel_deploy", {})!.action).toBe("deploy:vercel");
		expect(classifyToolAction("vercel_set_env", { key: "STRIPE" })!.risk).toBe("destructive");
		expect(classifyToolAction("enable_infinite_mode", {})!.action).toBe("infinite:enable");
	});
});

describe("assertMakerCheckerApproved (enforcement logic)", () => {
	test("RED-TEAM: unattended rm is hard-blocked with no approval, then allowed after approval", () => {
		const call = () =>
			assertMakerCheckerApproved(
				"run_command",
				{ command: "rm -rf /tmp/victim" },
				{ unattended: true, makerId: "autonomous" },
			);

		// 1. No approval -> throws typed block error, records a pending actionId.
		let blocked: MakerCheckerBlockedError | null = null;
		try {
			call();
		} catch (err) {
			blocked = err as MakerCheckerBlockedError;
		}
		expect(blocked).toBeInstanceOf(MakerCheckerBlockedError);
		expect(blocked!.code).toBe("MAKER_CHECKER_BLOCKED");
		expect(blocked!.risk).toBe("destructive");
		expect(blocked!.actionId).toBeTruthy();

		// 2. A checker approves the recorded action.
		const approved = getMakerCheckerStore().approve(
			blocked!.actionId,
			"human-checker",
			"human",
			"Reviewed and approved",
		);
		expect(approved).toBe(true);

		// 3. Same call now succeeds (no throw) — approval consumed one-shot.
		expect(call).not.toThrow();
	});

	test("interactive (attended) context is never gated", () => {
		expect(() =>
			assertMakerCheckerApproved(
				"run_command",
				{ command: "rm -rf /tmp/victim" },
				{ unattended: false },
			),
		).not.toThrow();
	});

	test("benign command in unattended context is never gated", () => {
		expect(() =>
			assertMakerCheckerApproved("run_command", { command: "ls -la" }, { unattended: true }),
		).not.toThrow();
	});

	test("git_push unattended is blocked", () => {
		expect(() =>
			assertMakerCheckerApproved("git_push", { branch: "feat/x" }, { unattended: true }),
		).toThrow(MakerCheckerBlockedError);
	});

	test("EIGHT_ENFORCE_CHECKER=0 is a kill switch even when unattended", () => {
		process.env.EIGHT_ENFORCE_CHECKER = "0";
		expect(() =>
			assertMakerCheckerApproved(
				"run_command",
				{ command: "rm -rf /tmp/victim" },
				{ unattended: true },
			),
		).not.toThrow();
	});

	test("EIGHT_ENFORCE_CHECKER=1 forces enforcement even when attended", () => {
		process.env.EIGHT_ENFORCE_CHECKER = "1";
		expect(() =>
			assertMakerCheckerApproved(
				"run_command",
				{ command: "rm -rf /tmp/victim" },
				{ unattended: false },
			),
		).toThrow(MakerCheckerBlockedError);
	});
});

describe("RED-TEAM: real chokepoint (ToolExecutor.executeRaw)", () => {
	test("autonomous rm is blocked at the chokepoint; the file is NOT deleted", async () => {
		const dir = mkdtempSync(join(tmpdir(), "mc-redteam-"));
		const victim = join(dir, "keep-me.txt");
		writeFileSync(victim, "important");

		const exec = new ToolExecutor(dir, "autonomous", undefined, { unattended: true });
		const result = await exec.execute("run_command", { command: `rm -f ${victim}` });

		// The maker-checker marker only exists because enforcement ran.
		expect(result).toContain("[MAKER-CHECKER BLOCKED]");
		// The destructive tool never reached the shell.
		expect(existsSync(victim)).toBe(true);

		// Extract the pending actionId and approve it.
		const m = result.match(/actionId=(\S+)/);
		expect(m).not.toBeNull();
		const actionId = m![1].replace(/\.$/, "");
		expect(getMakerCheckerStore().approve(actionId, "human-checker", "human")).toBe(true);

		// After approval the gate opens (no block marker on retry).
		const retry = await exec.execute("run_command", { command: `rm -f ${victim}` });
		expect(retry).not.toContain("[MAKER-CHECKER BLOCKED]");
	});

	test("attended executor runs the same rm without the maker-checker gate", async () => {
		const dir = mkdtempSync(join(tmpdir(), "mc-attended-"));
		const f = join(dir, "f.txt");
		writeFileSync(f, "x");

		const exec = new ToolExecutor(dir, "primary", undefined, { unattended: false });
		const result = await exec.execute("run_command", { command: `rm -f ${f}` });
		expect(result).not.toContain("[MAKER-CHECKER BLOCKED]");
	});
});
