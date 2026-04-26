/**
 * Tests for the Turth interactive approval system.
 *
 * Covers:
 *  1. Feature flag off: requestApproval() short-circuits to allowed:true.
 *  2. Feature flag on, no surface: fail-closed with requiresApproval:true.
 *  3. Session scope caches in-memory until clearSession().
 *  4. Project scope is keyed by cwd.
 *  5. Always scope persists across a loaded instance.
 *  6. Deny decisions propagate as allowed:false.
 *  7. Surface cancel -> deny (no state written).
 */

import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";

// Point EIGHT_DATA_DIR at an isolated temp dir before importing the modules.
const TMP_DIR = path.join(os.tmpdir(), `turth-test-${Date.now()}`);
fs.mkdirSync(TMP_DIR, { recursive: true });
process.env.EIGHT_DATA_DIR = TMP_DIR;

import {
	requestApproval,
	registerPromptSurface,
	isInteractiveEnabled,
	type TurthRequest,
} from "./turth.js";
import {
	__resetForTest,
	checkCapability,
	recordDecision,
	clearSession,
	getAuditLogPath,
	getUserPolicyPath,
} from "./user-policy.js";

function mockSurface(
	fixed: "once" | "session" | "project" | "always" | "deny",
) {
	let calls = 0;
	registerPromptSurface(async (_req: TurthRequest) => {
		calls++;
		return fixed;
	});
	return () => calls;
}

describe("Turth feature flag", () => {
	beforeEach(() => {
		__resetForTest();
		registerPromptSurface(null);
	});

	it("returns allowed:true when PERMISSIONS_INTERACTIVE is unset", async () => {
		delete process.env.PERMISSIONS_INTERACTIVE;
		expect(isInteractiveEnabled()).toBe(false);
		const dec = await requestApproval({
			capability: "run_command:echo",
			summary: "run echo",
		});
		expect(dec.allowed).toBe(true);
	});

	it("fails closed when enabled but no surface registered", async () => {
		process.env.PERMISSIONS_INTERACTIVE = "1";
		const dec = await requestApproval({
			capability: "run_command:rm",
			summary: "delete file",
		});
		expect(dec.allowed).toBe(false);
		if (!dec.allowed) {
			expect(dec.requiresApproval).toBe(true);
		}
	});
});

describe("Turth scope persistence", () => {
	beforeEach(() => {
		__resetForTest();
		registerPromptSurface(null);
		process.env.PERMISSIONS_INTERACTIVE = "1";
	});

	it("session scope caches for the process lifetime", async () => {
		const countCalls = mockSurface("session");
		const cap = "run_command:ls";
		const a = await requestApproval({ capability: cap, summary: "ls" });
		const b = await requestApproval({ capability: cap, summary: "ls" });
		expect(a.allowed).toBe(true);
		expect(b.allowed).toBe(true);
		// Second call should NOT re-prompt.
		expect(countCalls()).toBe(1);

		clearSession();
		await requestApproval({ capability: cap, summary: "ls" });
		expect(countCalls()).toBe(2);
	});

	it("project scope is keyed by cwd", async () => {
		const countCalls = mockSurface("project");
		const cap = "write_file:config";
		await requestApproval({ capability: cap, summary: "write", cwd: "/tmp/a" });
		const cachedA = checkCapability(cap, "/tmp/a");
		const cachedB = checkCapability(cap, "/tmp/b");
		expect(cachedA?.allowed).toBe(true);
		expect(cachedB).toBeNull();
		expect(countCalls()).toBe(1);
	});

	it("always scope persists to disk", async () => {
		mockSurface("always");
		const cap = "network_request:api.example.com";
		await requestApproval({ capability: cap, summary: "call api" });
		const file = getUserPolicyPath();
		expect(fs.existsSync(file)).toBe(true);
		const raw = JSON.parse(fs.readFileSync(file, "utf-8"));
		expect(raw.always[cap]).toBe(true);
	});

	it("deny propagates allowed:false and is NOT cached", async () => {
		const countCalls = mockSurface("deny");
		const cap = "secret_write:token";
		const a = await requestApproval({
			capability: cap,
			summary: "write token",
		});
		const b = await requestApproval({
			capability: cap,
			summary: "write token",
		});
		expect(a.allowed).toBe(false);
		expect(b.allowed).toBe(false);
		// Each call should re-prompt because deny is never cached.
		expect(countCalls()).toBe(2);
	});

	it("once scope does NOT cache", async () => {
		const countCalls = mockSurface("once");
		const cap = "env_access:FOO";
		await requestApproval({ capability: cap, summary: "read env" });
		await requestApproval({ capability: cap, summary: "read env" });
		expect(countCalls()).toBe(2);
	});
});

describe("Turth audit log", () => {
	beforeEach(() => {
		__resetForTest();
		registerPromptSurface(null);
		process.env.PERMISSIONS_INTERACTIVE = "1";
		// Clear any prior audit log from earlier tests.
		const logPath = getAuditLogPath();
		if (fs.existsSync(logPath)) fs.unlinkSync(logPath);
	});

	it("appends one entry per non-once decision", async () => {
		mockSurface("session");
		const cap = "run_command:pwd";
		await requestApproval({ capability: cap, summary: "pwd" });

		const logPath = getAuditLogPath();
		expect(fs.existsSync(logPath)).toBe(true);
		const lines = fs
			.readFileSync(logPath, "utf-8")
			.trim()
			.split("\n")
			.filter(Boolean);
		expect(lines.length).toBeGreaterThanOrEqual(1);
		const entry = JSON.parse(lines[lines.length - 1]);
		expect(entry.capability).toBe(cap);
		expect(entry.scope).toBe("session");
		expect(entry.allowed).toBe(true);
		expect(typeof entry.ts).toBe("string");
		expect(typeof entry.actor).toBe("string");
		expect(typeof entry.cwd).toBe("string");
	});
});

afterEach(() => {
	registerPromptSurface(null);
});
