/**
 * #310 follow-up (8SO read of PR #313): a refusal with nobody present leaves a record and
 * tells the model the truth.
 *
 * 1. The record. On main, a System One escalation on a terminal with no card and
 *    EIGHT_UNATTENDED set went to askOneYes, which refused and wrote one
 *    `one-yes-resolved-no` line (reason unattended-env, label system-one-escalation) to
 *    <home>/.8gent/one-yes-denials.jsonl. The refusal must still write exactly that line,
 *    on the no-card path and on the TUI path, where a card would have been raised.
 * 2. The words. Nobody was asked, so no refusal on the unattended path says a person
 *    declined, and none names a switch that turns the gate off.
 *
 * Production call shape: ToolExecutor.execute for run_command and desktop control, and the
 * MCP gate's exported askers, with stdin a terminal and EIGHT_HEADLESS unset (the pilot's pane).
 */

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { cleanupTempDirs, tempDir } from "../../tests/temp-dirs";
import { createDecider } from "../decide/index";
import type { DecideBackend, SystemOneRequest, SystemOneResponse } from "../decide/types";
import { ToolExecutor } from "../eight/tools";
import { askMcpApproval, askMcpStartApproval } from "./mcp-gate";
import {
	SYSTEM_ONE_ALLOWLIST_FLAG,
	SYSTEM_ONE_FLAG,
	_resetSystemOne,
	_setSystemOneOverridesForTests,
} from "./system-one-gate";
import {
	type TuiApprovalRequest,
	_resetTuiApprovalChannel,
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
				{ id: request.questions[0].id, kind: "noul", probabilities: { yes: 0.5 }, confidence: 0.5 },
			],
			backend: this.name,
			model: this.model,
			latencyMs: 0,
		};
	}
}

const KEYS = [
	SYSTEM_ONE_FLAG,
	SYSTEM_ONE_ALLOWLIST_FLAG,
	"EIGHT_HEADLESS",
	"EIGHT_UNATTENDED",
	"EIGHT_HOME",
	"CI",
];
const saved: Record<string, string | undefined> = {};
let ttyWas: PropertyDescriptor | undefined;
let dir: string;
let home: string;
let cards: TuiApprovalRequest[];

/** The lines the one-yes ledger holds under this test's home. */
function ledger(): Record<string, unknown>[] {
	const file = join(home, ".8gent", "one-yes-denials.jsonl");
	if (!existsSync(file)) return [];
	return readFileSync(file, "utf8")
		.split("\n")
		.filter(Boolean)
		.map((l) => JSON.parse(l));
}

/** A card handler that would say yes: under unattended it must never be called. */
function registerYesCard(): void {
	registerTuiApprovalHandler(async (req) => {
		cards.push(req);
		return "approve";
	});
}

/** Nothing on the unattended path may say a person answered, or name a way around the gate. */
function expectTruthfulRefusal(out: unknown): void {
	const text = String(out);
	expect(text).not.toMatch(/declined/i);
	expect(text).not.toMatch(/\bapproved\b/i);
	expect(text).not.toContain(`${SYSTEM_ONE_FLAG}=0`);
	expect(text).toMatch(/no one (is present )?to ask/);
}

beforeAll(() => {
	for (const k of KEYS) saved[k] = process.env[k];
	ttyWas = Object.getOwnPropertyDescriptor(process.stdin, "isTTY");
});

afterAll(() => {
	_resetSystemOne();
	_resetTuiApprovalChannel();
	for (const k of KEYS) {
		if (saved[k] === undefined) delete process.env[k];
		else process.env[k] = saved[k];
	}
	if (ttyWas) Object.defineProperty(process.stdin, "isTTY", ttyWas);
	else Reflect.deleteProperty(process.stdin, "isTTY");
});

beforeEach(() => {
	dir = tempDir("unattended-record-310-");
	home = tempDir("unattended-record-310-home-");
	_setSystemOneOverridesForTests({
		createDecider: () => createDecider({ backend: new UnsureBackend(), cacheSize: 0 }),
		calibrationDir: tempDir("unattended-record-310-nocal-"),
	});
	// The pilot's pane: a terminal, not headless, nobody present.
	Object.defineProperty(process.stdin, "isTTY", { value: true, configurable: true });
	Reflect.deleteProperty(process.env, "EIGHT_HEADLESS");
	Reflect.deleteProperty(process.env, "CI");
	process.env.EIGHT_UNATTENDED = "1";
	process.env.EIGHT_HOME = home;
	process.env[SYSTEM_ONE_FLAG] = "1";
	process.env[SYSTEM_ONE_ALLOWLIST_FLAG] = "0";
	cards = [];
	_resetTuiApprovalChannel();
});

afterEach(() => {
	_resetTuiApprovalChannel();
	rmSync(dir, { recursive: true, force: true });
});

/** What main writes for this refusal: one line, refused because nobody could answer. */
const MAIN_LINE = {
	event: "one-yes-resolved-no",
	reason: "unattended-env",
	label: "system-one-escalation",
};

describe("#310 a refused System One escalation leaves the line main wrote", () => {
	test("no card, a terminal: exactly one ledger line, reason unattended-env", async () => {
		const made = join(dir, "made-no-card.txt");
		const out = await new ToolExecutor(dir, "record-310").execute("run_command", {
			command: `touch ${made}`,
		});

		expect(existsSync(made)).toBe(false);
		const lines = ledger();
		expect(lines.length).toBe(1);
		expect(lines[0]).toMatchObject(MAIN_LINE);
		expect(Object.keys(lines[0]).sort()).toEqual(["at", "event", "label", "reason"]);
		expectTruthfulRefusal(out);
	});

	test("TUI path, a card handler registered: no card, the same one line", async () => {
		registerYesCard();
		const made = join(dir, "made-card.txt");
		const out = await new ToolExecutor(dir, "record-310").execute("run_command", {
			command: `touch ${made}`,
		});

		expect(cards).toEqual([]);
		expect(existsSync(made)).toBe(false);
		const lines = ledger();
		expect(lines.length).toBe(1);
		expect(lines[0]).toMatchObject(MAIN_LINE);
		expectTruthfulRefusal(out);
	});
});

describe("#310 no refusal on the unattended path says a person declined", () => {
	for (const withCard of [false, true]) {
		const where = withCard ? "card handler registered" : "no card";
		test(`MCP call (${where})`, async () => {
			if (withCard) registerYesCard();
			const out = await askMcpApproval("fs", "write_file", { path: "/tmp/x" }, undefined);
			expect(out).not.toBeNull();
			expect(out).toStartWith("[BLOCKED]");
			expect(cards).toEqual([]);
			expectTruthfulRefusal(out);
		});

		test(`MCP start (${where})`, async () => {
			if (withCard) registerYesCard();
			const out = await askMcpStartApproval(["notes: /bin/sh -c x"]);
			expect(out).not.toBeNull();
			expect(out).toStartWith("[BLOCKED]");
			expect(cards).toEqual([]);
			expectTruthfulRefusal(out);
		});

		test(`desktop control (${where})`, async () => {
			if (withCard) registerYesCard();
			const marker = join(dir, `pwned-${withCard ? "card" : "nocard"}`);
			const out = await new ToolExecutor(dir, "record-310").execute("desktop_quit_app", {
				name: `Safari$(touch ${marker})`,
			});
			expect(out).toStartWith("[BLOCKED]");
			expect(cards).toEqual([]);
			expect(existsSync(marker)).toBe(false);
			expectTruthfulRefusal(out);
		});

		test(`run_command generic approval, System One off (${where})`, async () => {
			if (withCard) registerYesCard();
			process.env[SYSTEM_ONE_FLAG] = "0";
			// mkfifo is not on the allow list, so the generic approval asks a person.
			const made = join(dir, `made-generic-${withCard ? "card" : "nocard"}`);
			const out = await new ToolExecutor(dir, "record-310").execute("run_command", {
				command: `mkfifo ${made}`,
			});
			expect(cards).toEqual([]);
			expect(existsSync(made)).toBe(false);
			expectTruthfulRefusal(out);
		});
	}
});
