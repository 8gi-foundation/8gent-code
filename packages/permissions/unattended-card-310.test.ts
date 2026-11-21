/**
 * #310: an unattended turn held on an approval card nobody could answer.
 *
 * Pilot sigi-dev-arc1-a (run 2026-11-20_041500): the judge was unavailable, so
 * System One sent `python3 .../decode.py` to a person, the TUI raised its card
 * (first the one-time yolo question), and the turn waited 21 minutes for a key
 * that never came. Nothing told the model why.
 *
 * Unattended means no. With nobody present (EIGHT_UNATTENDED, or an owned
 * terminal session) a question that needs a person's yes resolves at once to a
 * refusal the model can read, the card handler is never called, and nothing
 * runs. An attended session keeps the card exactly as before.
 *
 * The path is the one that ships: ToolExecutor.execute("run_command"), the real
 * System One gate with its default human prompt, and a registered TUI handler,
 * with stdin a terminal and EIGHT_HEADLESS unset, as in the pilot's pane.
 */

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, rmSync } from "node:fs";
import { join } from "node:path";
import { cleanupTempDirs, tempDir } from "../../tests/temp-dirs";
import { createDecider } from "../decide/index";
import type { DecideBackend, SystemOneRequest, SystemOneResponse } from "../decide/types";
import { ToolExecutor } from "../eight/tools";
import {
	SYSTEM_ONE_ALLOWLIST_FLAG,
	SYSTEM_ONE_FLAG,
	_resetSystemOne,
	_setSystemOneOverridesForTests,
} from "./system-one-gate";
import {
	type TuiApprovalDecision,
	type TuiApprovalRequest,
	UNATTENDED_REFUSAL,
	registerTuiApprovalHandler,
} from "./tui-approval-channel";

afterAll(cleanupTempDirs);

/** A judge that is always unsure: every command it sees is a person's call. */
class UnsureBackend implements DecideBackend {
	readonly name = "stub";
	readonly model = "stub-model";
	async ask(request: SystemOneRequest): Promise<SystemOneResponse> {
		return {
			answers: [
				{
					id: request.questions[0].id,
					kind: "noul",
					probabilities: { yes: 0.5 },
					confidence: 0.5,
				},
			],
			backend: this.name,
			model: this.model,
			latencyMs: 0,
		};
	}
}

const KEYS = [SYSTEM_ONE_FLAG, SYSTEM_ONE_ALLOWLIST_FLAG, "EIGHT_HEADLESS", "EIGHT_UNATTENDED"];
const saved: Record<string, string | undefined> = {};
let ttyWas: PropertyDescriptor | undefined;

let dir: string;
let executor: ToolExecutor;
let cards: TuiApprovalRequest[];
/** Settles the card that is up, as a person's key would. */
let answerCard: ((d: TuiApprovalDecision) => void) | null;

/** Resolves to the value, or to "still waiting" if it has not settled within `ms`. */
const within = <T>(p: Promise<T>, ms: number): Promise<T | "still waiting"> =>
	Promise.race([p, new Promise<"still waiting">((r) => setTimeout(() => r("still waiting"), ms))]);

beforeAll(() => {
	for (const k of KEYS) saved[k] = process.env[k];
	ttyWas = Object.getOwnPropertyDescriptor(process.stdin, "isTTY");
});

afterAll(() => {
	_resetSystemOne();
	registerTuiApprovalHandler(null);
	for (const k of KEYS) {
		if (saved[k] === undefined) delete process.env[k];
		else process.env[k] = saved[k];
	}
	if (ttyWas) Object.defineProperty(process.stdin, "isTTY", ttyWas);
	else Reflect.deleteProperty(process.stdin, "isTTY");
});

beforeEach(() => {
	dir = tempDir("unattended-310-");
	executor = new ToolExecutor(dir, "unattended-310");
	_setSystemOneOverridesForTests({
		createDecider: () => createDecider({ backend: new UnsureBackend(), cacheSize: 0 }),
		calibrationDir: tempDir("unattended-310-nocal-"),
	});
	// The pilot's pane: a terminal, not headless, System One on with no allowlist shortcut.
	Object.defineProperty(process.stdin, "isTTY", { value: true, configurable: true });
	Reflect.deleteProperty(process.env, "EIGHT_HEADLESS");
	Reflect.deleteProperty(process.env, "EIGHT_UNATTENDED");
	process.env[SYSTEM_ONE_FLAG] = "1";
	process.env[SYSTEM_ONE_ALLOWLIST_FLAG] = "0";
	cards = [];
	answerCard = null;
	// The TUI's card: it stays up until a key answers it (useApprovalCard).
	registerTuiApprovalHandler(
		(req) =>
			new Promise<TuiApprovalDecision>((resolve) => {
				cards.push(req);
				answerCard = resolve;
			}),
	);
});

afterEach(() => {
	answerCard?.("deny");
	registerTuiApprovalHandler(null);
	rmSync(dir, { recursive: true, force: true });
});

describe("#310 an unattended turn never waits on a card", () => {
	test("unattended: run_command that needs a person's yes is refused at once, no card, nothing runs", async () => {
		process.env.EIGHT_UNATTENDED = "1";
		const made = join(dir, "made-310.txt");
		const started = Date.now();
		const out = await within(executor.execute("run_command", { command: `touch ${made}` }), 3000);
		const took = Date.now() - started;

		expect(out).not.toBe("still waiting");
		expect(took).toBeLessThan(3000);
		expect(cards).toEqual([]);
		expect(existsSync(made)).toBe(false);
		expect(String(out)).toContain(UNATTENDED_REFUSAL);
		expect(String(out)).toContain("was not run");
		// The model is not told a person declined: nobody was asked.
		expect(String(out)).not.toContain("the user declined");
	});

	test("attended: the same command raises the card and waits for the person", async () => {
		const made = join(dir, "made-310-attended.txt");
		const run = executor.execute("run_command", { command: `touch ${made}` });

		expect(await within(run, 1500)).toBe("still waiting");
		expect(cards.length).toBe(1);
		expect(cards[0].command).toContain(`touch ${made}`);
		expect(existsSync(made)).toBe(false);

		// The person says no: the turn goes on with a refusal, nothing ran.
		answerCard?.("deny");
		const out = await within(run, 3000);
		expect(out).not.toBe("still waiting");
		expect(String(out)).not.toContain(UNATTENDED_REFUSAL);
		expect(existsSync(made)).toBe(false);
	});
});
