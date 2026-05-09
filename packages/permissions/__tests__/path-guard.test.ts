/**
 * Tests for path-guard.ts - issue #2465
 *
 * Acceptance criteria mapped 1:1 to test cases below.
 */

import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { evaluatePolicy } from "../policy-engine";
import { validatePath } from "../path-guard";

// Real on-disk fixtures so realpathSync resolves symlinks.
const FAKE_HOME = fs.mkdtempSync(path.join(os.tmpdir(), "pg-home-"));
const FAKE_PROJ = fs.mkdtempSync(path.join(os.tmpdir(), "pg-proj-"));

beforeAll(() => {
	// Build a fake ~/.ssh with a key so the symlink target exists.
	fs.mkdirSync(path.join(FAKE_HOME, ".ssh"), { recursive: true });
	fs.writeFileSync(path.join(FAKE_HOME, ".ssh", "id_rsa"), "FAKE-KEY");
	fs.writeFileSync(path.join(FAKE_PROJ, "ok.txt"), "hi");
	process.env.EIGHT_FAKE_HOME = FAKE_HOME;
});

afterAll(() => {
	fs.rmSync(FAKE_HOME, { recursive: true, force: true });
	fs.rmSync(FAKE_PROJ, { recursive: true, force: true });
	delete process.env.EIGHT_FAKE_HOME;
});

afterEach(() => {
	delete process.env.SAFE_PATHS;
});

// --- AC1: protected credential file ---
describe("AC1: protected credential file under ~/.ssh", () => {
	test("rejects /Users/x/.ssh/id_rsa with reason 'protected credential file'", () => {
		const r = validatePath(path.join(FAKE_HOME, ".ssh", "id_rsa"), FAKE_PROJ);
		expect(r.ok).toBe(false);
		if (!r.ok) expect(r.reason).toMatch(/protected credential file/i);
	});

	test("rejects ~/.aws/credentials", () => {
		const p = path.join(FAKE_HOME, ".aws", "credentials");
		const r = validatePath(p, FAKE_PROJ);
		expect(r.ok).toBe(false);
	});

	test("rejects ~/.kube/config", () => {
		const p = path.join(FAKE_HOME, ".kube", "config");
		const r = validatePath(p, FAKE_PROJ);
		expect(r.ok).toBe(false);
	});
});

// --- AC2: workspace-internal path accepted ---
describe("AC2: workspace-internal paths accepted", () => {
	test("accepts /Users/x/proj/src/index.ts", () => {
		const r = validatePath(path.join(FAKE_PROJ, "src", "index.ts"), FAKE_PROJ);
		expect(r.ok).toBe(true);
	});
});

// --- AC3: path resolution catches escapes via .. ---
describe("AC3: '..' escape into protected dir", () => {
	test("rejects /Users/x/proj/../../.aws/credentials when target is protected", () => {
		// Build a path that escapes into FAKE_HOME/.aws/credentials via '..'
		// Note: validatePath resolves first, then checks against protected dirs.
		const escaped = path.join(FAKE_PROJ, "..", path.basename(FAKE_HOME), ".aws", "credentials");
		const r = validatePath(escaped, FAKE_PROJ);
		expect(r.ok).toBe(false);
	});
});

// --- AC4: device files ---
describe("AC4: device files", () => {
	test("rejects /dev/zero with reason 'device file'", () => {
		const r = validatePath("/dev/zero", "/tmp");
		expect(r.ok).toBe(false);
		if (!r.ok) expect(r.reason).toMatch(/device file/i);
	});

	test("rejects /dev/null", () => {
		const r = validatePath("/dev/null", "/tmp");
		expect(r.ok).toBe(false);
	});
});

// --- AC5: UNC paths ---
describe("AC5: UNC paths rejected", () => {
	test("rejects //server/share/x with reason 'UNC path not allowed'", () => {
		const r = validatePath("//server/share/x", "/tmp");
		expect(r.ok).toBe(false);
		if (!r.ok) expect(r.reason).toMatch(/UNC path not allowed/i);
	});

	test("rejects \\\\server\\share\\x", () => {
		const r = validatePath("\\\\server\\share\\x", "/tmp");
		expect(r.ok).toBe(false);
	});
});

// --- AC6: symlink to ~/.ssh rejected (real symlink fixture) ---
describe("AC6: symlink that points into ~/.ssh", () => {
	test("rejects a symlink inside the project that targets the credential dir", () => {
		const linkPath = path.join(FAKE_PROJ, "sneaky-link");
		// Skip if symlink unsupported (Windows w/o privilege)
		try {
			if (fs.existsSync(linkPath)) fs.unlinkSync(linkPath);
			fs.symlinkSync(path.join(FAKE_HOME, ".ssh", "id_rsa"), linkPath);
		} catch {
			return; // Cannot create symlink in this environment
		}
		const r = validatePath(linkPath, FAKE_PROJ);
		expect(r.ok).toBe(false);
		fs.unlinkSync(linkPath);
	});
});

// --- AC7: cross-platform Windows device names ---
describe("AC7: Windows device names", () => {
	test("on darwin/linux NUL/CON/PRN inside project are harmless", () => {
		if (process.platform === "win32") return;
		const p = path.join(FAKE_PROJ, "NUL");
		const r = validatePath(p, FAKE_PROJ);
		expect(r.ok).toBe(true);
	});

	// Pure-logic check that the win32 branch rejects the names.
	// We invoke the exported helper rather than mocking process.platform.
	test("isWindowsDeviceName recognises NUL/CON/PRN/AUX/COM1/LPT1", async () => {
		const { isWindowsDeviceName } = await import("../path-guard");
		expect(isWindowsDeviceName("NUL")).toBe(true);
		expect(isWindowsDeviceName("CON")).toBe(true);
		expect(isWindowsDeviceName("PRN")).toBe(true);
		expect(isWindowsDeviceName("AUX")).toBe(true);
		expect(isWindowsDeviceName("COM1")).toBe(true);
		expect(isWindowsDeviceName("LPT1")).toBe(true);
		expect(isWindowsDeviceName("nul.txt")).toBe(true); // base name w/ extension still device
		expect(isWindowsDeviceName("hello.txt")).toBe(false);
	});
});

// --- AC8: SAFE_PATHS allowlist override ---
describe("AC8: SAFE_PATHS env override", () => {
	test("override permits a single protected path", () => {
		const target = path.join(FAKE_HOME, ".gitconfig");
		fs.writeFileSync(target, "[user]\n  name = test\n");
		// Without override: rejected
		const blocked = validatePath(target, FAKE_PROJ);
		expect(blocked.ok).toBe(false);

		// With override: allowed
		process.env.SAFE_PATHS = target;
		const allowed = validatePath(target, FAKE_PROJ);
		expect(allowed.ok).toBe(true);

		// Override does NOT leak to other protected paths
		const otherBlocked = validatePath(path.join(FAKE_HOME, ".ssh", "id_rsa"), FAKE_PROJ);
		expect(otherBlocked.ok).toBe(false);

		fs.unlinkSync(target);
	});

	test("comma-separated SAFE_PATHS parses multiple entries", () => {
		const a = path.join(FAKE_HOME, ".npmrc");
		const b = path.join(FAKE_HOME, ".pypirc");
		fs.writeFileSync(a, "");
		fs.writeFileSync(b, "");
		process.env.SAFE_PATHS = `${a},${b}`;
		expect(validatePath(a, FAKE_PROJ).ok).toBe(true);
		expect(validatePath(b, FAKE_PROJ).ok).toBe(true);
		// Other still blocked
		expect(validatePath(path.join(FAKE_HOME, ".ssh", "id_rsa"), FAKE_PROJ).ok).toBe(false);
		fs.unlinkSync(a);
		fs.unlinkSync(b);
	});
});

// --- Credential basenames ---
describe("Credential basenames", () => {
	test.each([
		"id_rsa",
		"id_rsa.pub",
		"id_ed25519",
		"id_ed25519.pub",
		"id_ecdsa",
		"id_ecdsa.pub",
		"id_dsa",
		"id_dsa.pub",
		".netrc",
		".gitconfig",
		".npmrc",
		".pypirc",
		"credentials",
	])("rejects basename %s anywhere", (name) => {
		const p = path.join(FAKE_PROJ, name);
		const r = validatePath(p, FAKE_PROJ);
		expect(r.ok).toBe(false);
	});
});

// --- Integration: policy-engine routes through validatePath FIRST ---
describe("Integration: evaluatePolicy denies before consulting other rules", () => {
	test("read_file on ~/.ssh/id_rsa is denied via path-guard", () => {
		const decision = evaluatePolicy("read_file", {
			path: path.join(FAKE_HOME, ".ssh", "id_rsa"),
			workingDirectory: FAKE_PROJ,
		});
		expect(decision.allowed).toBe(false);
		if (!decision.allowed) expect(decision.reason).toMatch(/path-guard/i);
	});

	test("write_file on /dev/zero is denied via path-guard", () => {
		const decision = evaluatePolicy("write_file", {
			path: "/dev/zero",
			workingDirectory: FAKE_PROJ,
		});
		expect(decision.allowed).toBe(false);
	});

	test("read_file inside project still allowed by path-guard layer", () => {
		const decision = evaluatePolicy("read_file", {
			path: path.join(FAKE_PROJ, "ok.txt"),
			workingDirectory: FAKE_PROJ,
			workspaceRoot: FAKE_PROJ,
		});
		// May still be allowed or blocked by other rules; we only assert path-guard
		// did not produce a denial reason.
		if (!decision.allowed) {
			expect(decision.reason).not.toMatch(/path-guard/i);
		}
	});
});
