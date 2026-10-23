/**
 * The System One gate with 8J selected (EIGHT_8J_URL) and its server not answering: default mode
 * must send the command to a person (headless: block), never fall back to rules-only allow. The
 * same failure with no judge selected keeps the rules-only fallback, unchanged.
 */

import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createDecider } from "../decide/index";
import { _resetSystemOne, _setSystemOneOverridesForTests, systemOneGate } from "./system-one-gate";

const DEAD = "http://127.0.0.1:9";
const COMMAND = "make build";

const dirs: string[] = [];

function install(
	env: Record<string, string | undefined>,
	human: boolean | null,
	asked: string[],
): void {
	const calibrationDir = mkdtempSync(join(tmpdir(), "s1-8j-"));
	dirs.push(calibrationDir);
	_setSystemOneOverridesForTests({
		createDecider: () => createDecider({ env, llamacppLoader: null, cacheSize: 0 }),
		askHuman: async (req) => {
			asked.push(req.command);
			return human;
		},
		calibrationDir,
	});
}

afterEach(() => {
	_resetSystemOne();
	for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

describe("gate with 8j selected and down", () => {
	test("default mode: a person decides; no person is a block", async () => {
		const env = { EIGHT_8J_URL: DEAD, EIGHT_SYSTEM_ONE_ALLOWLIST: "0", HOME: tmpdir() };
		const asked: string[] = [];
		install(env, null, asked);
		const r = await systemOneGate(COMMAND, env);
		expect(r.run).toBe(false);
		expect(r.guard?.verdict).toBe("escalate");
		expect(asked).toEqual([COMMAND]);
	});

	test("default mode: the person can approve it", async () => {
		const env = { EIGHT_8J_URL: DEAD, EIGHT_SYSTEM_ONE_ALLOWLIST: "0", HOME: tmpdir() };
		const asked: string[] = [];
		install(env, true, asked);
		const r = await systemOneGate(COMMAND, env);
		expect(r.run).toBe(true);
		expect(r.humanApproved).toBe(true);
	});

	test("without 8j selected the rules-only fallback is unchanged", async () => {
		const env = {
			EIGHT_SYSTEM_ONE_ALLOWLIST: "0",
			HOME: tmpdir(),
			EIGHT_S1_SHARED_JUDGE: "0",
			LAYA_URL: DEAD,
			OLLAMA_HOST: DEAD,
		};
		const asked: string[] = [];
		install(env, null, asked);
		const r = await systemOneGate(COMMAND, env);
		expect(r.run).toBe(true);
		expect(asked).toEqual([]);
	});
});
