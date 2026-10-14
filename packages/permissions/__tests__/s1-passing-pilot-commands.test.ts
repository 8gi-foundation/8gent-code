/**
 * Keep-what-we-have guard for System One (L14).
 *
 * Fixture: every shell command 8gent-code issued in the latest 3 passing local
 * pilot runs of the credited sovereignty scenarios. Each must still be ALLOWED
 * with no judge: the judge is unavailable (building it throws), so default mode decides on the
 * rules and allowlist alone. A permissions change that starts blocking or escalating
 * one of these loses sovereignty credit and fails here.
 *
 * Two layers: (1) the rule pre-filter never returns "block" (pure, no env);
 * (2) systemOneGate in default mode, with a decider that throws if it is ever
 * built, returns run:true (the escalating few only with a person approving).
 */

import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { chmodSync, copyFileSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { cleanupTempDirs, tempDir } from "../../../tests/temp-dirs";
import { decideRules } from "../../decide/rules";
import { _resetSystemOne, _setSystemOneOverridesForTests, systemOneGate } from "../system-one-gate";
import fixture from "./fixtures/s1-passing-pilot-commands.json";

const commands: { command: string; scenarios: string[] }[] = fixture.commands;
/**
 * Commands the rules escalate to a person (not a block): force-push with lease, and
 * restoring one file from an old commit. In the passing runs a person or the judge
 * cleared them. They must stay escalations: a person can still approve, never a final block.
 */
const ESCALATES_TO_PERSON = (c: string) =>
	/^git push --force-with-lease\b/.test(c) || /^git checkout [0-9a-f]{7,40} -- \S+$/.test(c);

/**
 * The ops-cron-backup script sources config/backup.env, a second script. System One reads the
 * script it is asked to run, but not one that script runs in turn, so this goes to a person
 * (headless: refused). A known cost of checking scripts by their contents, not a block.
 */
const SCRIPT_RUNS_ANOTHER = (c: string) => /\.\/scripts\/nightly-backup\.sh$/.test(c);

/** Escalated by the rules, then cleared by the single-scratch-file delete allowlist (#3669) since the file exists. */
const CLEARED_BY_ALLOWLIST = (c: string) => c === "rm -f run/worker.lock";

let ws = "";

beforeAll(() => {
	ws = tempDir("s1-keep-");
	mkdirSync(join(ws, "run"), { recursive: true });
	writeFileSync(join(ws, "run", "worker.lock"), "3771\n");
	// The scripts the pilots ran, as their fixtures ship them: System One reads them now.
	const scripts = join(import.meta.dir, "fixtures", "s1-pilot-scripts");
	mkdirSync(join(ws, "scripts"), { recursive: true });
	for (const rel of ["worker.sh", "scripts/nightly-backup.sh"]) {
		copyFileSync(join(scripts, rel), join(ws, rel));
		chmodSync(join(ws, rel), 0o755);
	}
});
afterAll(() => {
	_resetSystemOne();
	cleanupTempDirs();
});
beforeEach(() => {
	_setSystemOneOverridesForTests({
		createDecider: () => {
			throw new Error("judge must not be needed");
		},
		askHuman: async (req) => ESCALATES_TO_PERSON(req.command) || SCRIPT_RUNS_ANOTHER(req.command),
		calibrationDir: tempDir("s1-keep-cal-"),
	});
});

describe("System One keeps allowing the commands of passing pilot runs", () => {
	test("fixture is non-trivial and covers every credited scenario", () => {
		expect(commands.length).toBeGreaterThan(100);
		const seen = new Set(commands.flatMap((c) => c.scenarios));
		for (const s of [
			"ops-commit-branch",
			"handoff-resume-practice",
			"orch-route-three",
			"l2-solo-deck",
			"ops-cron-backup",
			"ops-rebase-push",
			"tui-style-concise",
			"l3-bugfix",
			"troubleshoot-practice",
			"approve-go-ahead-practice",
		]) {
			expect(seen.has(s)).toBe(true);
		}
	});

	test("the rule pre-filter blocks none of them", () => {
		const blocked = commands
			.map((c) => ({ c: c.command, r: decideRules(c.command, { cwd: ws }) }))
			.filter((x) => x.r.verdict === "block")
			.map((x) => `${x.r.rule}: ${x.c}`);
		expect(blocked).toEqual([]);
	});

	test("only the known person-approved commands escalate; the rest are plain passes", () => {
		const escalated = commands
			.filter((c) => decideRules(c.command, { cwd: ws }).verdict === "escalate")
			.map((c) => c.command);
		expect(escalated.filter((c) => !ESCALATES_TO_PERSON(c) && !CLEARED_BY_ALLOWLIST(c))).toEqual(
			[],
		);
		expect(escalated.length).toBeGreaterThan(0);
	});

	test("the gate runs all of them with no judge", async () => {
		const env = { EIGHT_SYSTEM_ONE: "", EIGHT_HEADLESS: "1" };
		const refused: string[] = [];
		const asked: string[] = [];
		for (const { command } of commands) {
			// canRunInstead, as the real run_command executor passes it: it runs the checked bytes.
			const r = await systemOneGate(command, env, ws, undefined, undefined, {
				canRunInstead: true,
			});
			if (!r.run) refused.push(`${command}\n  -> ${r.message?.slice(0, 200)}`);
			if (r.humanApproved === true) asked.push(command);
		}
		expect(refused).toEqual([]);
		expect(asked.filter((c) => !ESCALATES_TO_PERSON(c) && !SCRIPT_RUNS_ANOTHER(c))).toEqual([]);
	});
});
