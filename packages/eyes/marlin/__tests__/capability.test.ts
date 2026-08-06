/**
 * Capability gate tests (VIDEO-INGESTION spec §11). The capability is OFF BY
 * DEFAULT; a fresh install carries no Python.
 */

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { checkVideoCapability } from "../capability.js";

const ENV_KEY = "EIGHT_VIDEO_INGESTION";
let savedEnv: string | undefined;

// A guaranteed-empty home so the "not installed" path is exercised even on a
// developer machine that actually has Marlin provisioned at ~/.8gent. Without
// this the test read real disk state and failed for anyone with the venv.
let emptyHome: string;

beforeEach(() => {
	savedEnv = process.env[ENV_KEY];
	delete process.env[ENV_KEY];
	emptyHome = mkdtempSync(join(tmpdir(), "marlin-cap-"));
});
afterEach(() => {
	if (savedEnv === undefined) delete process.env[ENV_KEY];
	else process.env[ENV_KEY] = savedEnv;
	rmSync(emptyHome, { recursive: true, force: true });
});

describe("checkVideoCapability", () => {
	test("is not installed by default (no flag, no venv)", () => {
		const cap = checkVideoCapability(emptyHome);
		expect(cap.installed).toBe(false);
		expect(cap.flagEnabled).toBe(false);
		expect(cap.reason).toBeDefined();
		expect(cap.reason).toContain("8gent vision install");
	});

	test("the env override flips the flag on, but the venv is still required", () => {
		process.env[ENV_KEY] = "1";
		const cap = checkVideoCapability(emptyHome);
		expect(cap.flagEnabled).toBe(true);
		// Empty home -> no provisioned venv -> installed stays false and the
		// reason points at the missing sidecar.
		expect(cap.venvPresent).toBe(false);
		expect(cap.installed).toBe(false);
		expect(cap.reason).toContain("venv");
	});
});
