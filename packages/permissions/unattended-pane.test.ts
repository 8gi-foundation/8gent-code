/**
 * S0 of the terminal session ownership spec (issue 180, the gap recorded in the reads of pull
 * request 199): nobody is present in an owned terminal session, so a request that would prompt is
 * refused whatever approve setting is on. A real PermissionManager, the real requestPermission.
 * Each case first shows the setting approving WITHOUT EIGHT_UNATTENDED, so the refusal is the
 * override and not the test's own setup.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PermissionManager, headlessApproveOptIn } from "./index";

// Not on the always-allowed list, not dangerous: it would prompt.
const PROMPTING = "somecustomtool --go";
const KEYS = ["EIGHT_UNATTENDED", "EIGHT_HEADLESS_APPROVE", "EIGHT_HEADLESS"] as const;
const saved: Record<string, string | undefined> = {};
const savedTTY = process.stdin.isTTY;
let dir = "";
let logs: string[] = [];
const realLog = console.log;

beforeEach(() => {
	for (const k of KEYS) {
		saved[k] = process.env[k];
		delete process.env[k];
	}
	(process.stdin as { isTTY?: boolean }).isTTY = false;
	dir = mkdtempSync(join(tmpdir(), "up-"));
	logs = [];
	console.log = (...a: unknown[]) => {
		logs.push(a.join(" "));
	};
});

afterEach(() => {
	console.log = realLog;
	for (const k of KEYS) {
		if (saved[k] === undefined) delete process.env[k];
		else process.env[k] = saved[k];
	}
	(process.stdin as { isTTY?: boolean }).isTTY = savedTTY;
	rmSync(dir, { recursive: true, force: true });
});

const manager = () => new PermissionManager(join(dir, "permissions.json"));
const ask = (m: PermissionManager) => m.requestPermission("Run", "a tool", PROMPTING);

describe("EIGHT_UNATTENDED overrides every approve setting", () => {
	test("EIGHT_HEADLESS_APPROVE=1 approves without it and is refused with it", async () => {
		process.env.EIGHT_HEADLESS_APPROVE = "1";
		expect(await ask(manager())).toBe(true);
		process.env.EIGHT_UNATTENDED = "1";
		expect(await ask(manager())).toBe(false);
		expect(logs.join("\n")).toContain("DENIED (unattended pane)");
		expect(headlessApproveOptIn()).toBe(false);
		expect(headlessApproveOptIn({ EIGHT_HEADLESS_APPROVE: "1", EIGHT_UNATTENDED: "1" })).toBe(
			false,
		);
		expect(headlessApproveOptIn({ EIGHT_HEADLESS_APPROVE: "1" })).toBe(true);
	});

	test("auto-approve approves without it and is refused with it", async () => {
		const m = manager();
		m.setAutoApprove(true);
		expect(await ask(m)).toBe(true);
		process.env.EIGHT_UNATTENDED = "1";
		expect(await ask(m)).toBe(false);
	});

	test("Infinite mode approves without it and is refused with it", async () => {
		const m = manager();
		m.enableInfiniteMode();
		expect(m.isInfiniteMode()).toBe(true);
		expect(await ask(m)).toBe(true);
		process.env.EIGHT_UNATTENDED = "1";
		expect(m.isInfiniteMode()).toBe(false);
		expect(m.checkPermission(PROMPTING)).toBe("ask");
		expect(await ask(m)).toBe(false);
	});

	test("a channel approver is not consulted, with a terminal attached or not", async () => {
		process.env.EIGHT_UNATTENDED = "1";
		for (const tty of [false, true]) {
			(process.stdin as { isTTY?: boolean }).isTTY = tty;
			expect(await ask(manager())).toBe(false);
		}
	});

	test("every question to a person is No", async () => {
		process.env.EIGHT_UNATTENDED = "1";
		(process.stdin as { isTTY?: boolean }).isTTY = true;
		expect(await manager().askPerson("Type", "into a session", "ls")).toBe(false);
	});

	test("always-allowed policy is unchanged", async () => {
		process.env.EIGHT_UNATTENDED = "1";
		expect(await manager().requestPermission("Run", "list files", "ls")).toBe(true);
	});

	test("a person's run without EIGHT_UNATTENDED is not narrowed", async () => {
		(process.stdin as { isTTY?: boolean }).isTTY = true;
		const m = manager();
		expect(m.checkPermission(PROMPTING)).toBe("ask");
		m.setAutoApprove(true);
		expect(await ask(m)).toBe(true);
	});
});
