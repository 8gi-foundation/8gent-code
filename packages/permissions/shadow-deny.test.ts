import { describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
	SHADOW_AGENT_RESTRICTIONS,
	SHADOW_AGENT_SCOPE,
	addPolicy,
	evaluatePolicy,
} from "./policy-engine";

const TMP_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "shadow-test-"));
process.env.EIGHT_DATA_DIR = TMP_DIR;

const SHADOW = { agentId: SHADOW_AGENT_SCOPE };

describe("Shadow-candidate hard-deny (issue #2699, 8SO P0-3)", () => {
	test("shadow scope is __shadow__", () => {
		expect(SHADOW_AGENT_SCOPE).toBe("__shadow__");
	});

	test("shadow candidate CANNOT write a file", () => {
		const d = evaluatePolicy("write_file", {
			...SHADOW,
			path: path.join(TMP_DIR, "out.txt"),
			content: "x",
		});
		expect(d.allowed).toBe(false);
		if (!d.allowed) expect(d.reason).toMatch(/shadow-deny/);
	});

	test("shadow candidate CANNOT run a command", () => {
		const d = evaluatePolicy("run_command", { ...SHADOW, command: "echo hi" });
		expect(d.allowed).toBe(false);
		if (!d.allowed) expect(d.reason).toMatch(/shadow-deny/);
	});

	test("shadow candidate CANNOT send email", () => {
		const d = evaluatePolicy("email_send", {
			...SHADOW,
			account_age_verified_13_plus: true,
		});
		expect(d.allowed).toBe(false);
	});

	test("shadow candidate CANNOT make a network request", () => {
		const d = evaluatePolicy("network_request", { ...SHADOW, url: "https://example.com" });
		expect(d.allowed).toBe(false);
		if (!d.allowed) expect(d.reason).toMatch(/shadow-deny/);
	});

	test("shadow candidate CANNOT git push", () => {
		const d = evaluatePolicy("git_push", { ...SHADOW, branch: "main" });
		expect(d.allowed).toBe(false);
	});

	test("shadow candidate CANNOT write a secret", () => {
		const d = evaluatePolicy("secret_write", { ...SHADOW, key: "API_KEY" });
		expect(d.allowed).toBe(false);
	});

	test("shadow candidate CAN read a file (read/compute is allowed)", () => {
		const d = evaluatePolicy("read_file", {
			...SHADOW,
			path: path.join(TMP_DIR, "in.txt"),
			workspaceRoot: TMP_DIR,
		});
		expect(d.allowed).toBe(true);
	});

	test("a YAML/runtime allow CANNOT lift the shadow deny (pre-gate beats addPolicy)", () => {
		// Even after adding a permissive require_approval rule for write_file,
		// the hard pre-gate still denies the shadow scope outright.
		addPolicy({
			name: "test-allow-tmp-writes",
			action: "write_file",
			condition: "path contains shadow-test",
			decision: "require_approval",
			message: "test rule",
		});
		const d = evaluatePolicy("write_file", {
			...SHADOW,
			path: path.join(TMP_DIR, "out2.txt"),
			content: "x",
		});
		expect(d.allowed).toBe(false);
		if (!d.allowed) expect(d.reason).toMatch(/shadow-deny/);
	});

	test("a NON-shadow agent is NOT affected by the shadow gate", () => {
		const d = evaluatePolicy("read_file", {
			agentId: "main",
			path: path.join(TMP_DIR, "in.txt"),
			workspaceRoot: TMP_DIR,
		});
		expect(d.allowed).toBe(true);
	});

	test("SHADOW_AGENT_RESTRICTIONS mirror the spawned pattern (belt-and-suspenders)", () => {
		expect(SHADOW_AGENT_RESTRICTIONS.length).toBeGreaterThan(0);
		for (const r of SHADOW_AGENT_RESTRICTIONS) {
			expect(r.agentScope).toBe(SHADOW_AGENT_SCOPE);
			expect(r.decision).toBe("block");
		}
	});
});
