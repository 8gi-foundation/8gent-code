/**
 * G1 hardening: an extension tool call is gated by ToolG8 as the
 * extension_call action, like every mapped built-in, before the extension
 * code runs. Drives ToolExecutor.execute directly with a fake extension
 * runner.
 */
import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { addPolicy } from "../permissions/policy-engine";
import { EXTENSION_POLICY_ACTION, ToolExecutor } from "./tools";

function executor(agentId: string) {
	const cwd = mkdtempSync(join(tmpdir(), "ext-policy-"));
	const ex = new ToolExecutor(cwd, agentId);
	const ran: string[] = [];
	ex.setExtensionRunner({
		has: (name) => name === "shout",
		run: async (name, args) => {
			ran.push(name);
			return `SHOUTED ${String(args.text)}`;
		},
	});
	return { ex, ran, cwd };
}

describe("extension tools go through the ToolG8 policy gate", () => {
	test("the action class is extension_call", () => {
		expect(EXTENSION_POLICY_ACTION).toBe("extension_call");
	});

	test("with no rule against it, the call runs", async () => {
		const { ex, ran, cwd } = executor("primary");
		try {
			expect(await ex.execute("shout", { text: "hi" })).toContain("SHOUTED hi");
			expect(ran).toEqual(["shout"]);
		} finally {
			rmSync(cwd, { recursive: true, force: true });
		}
	});

	test("a policy rule on extension_call blocks it before the extension code runs", async () => {
		addPolicy({
			name: "test-no-shout",
			action: "extension_call",
			condition: "tool equals shout",
			decision: "block",
			message: "shout is off for this scope",
			agentScope: "ext-policy-scope",
		});
		const { ex, ran, cwd } = executor("ext-policy-scope");
		try {
			const out = await ex.execute("shout", { text: "hi" });
			expect(out).toContain("shout is off for this scope");
			expect(ran).toEqual([]);
		} finally {
			rmSync(cwd, { recursive: true, force: true });
		}
	});

	test("a shadow candidate can never run an extension tool", async () => {
		const { ex, ran, cwd } = executor("__shadow__");
		try {
			const out = await ex.execute("shout", { text: "hi" });
			expect(out).toContain("shadow");
			expect(ran).toEqual([]);
		} finally {
			rmSync(cwd, { recursive: true, force: true });
		}
	});
});
