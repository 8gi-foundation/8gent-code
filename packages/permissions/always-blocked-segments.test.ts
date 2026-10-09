/**
 * #3768: the always-blocked check covers every command on a line, not only the
 * first. A line with an always-blocked segment in any position is refused in
 * every mode; ordinary multi-command lines still run.
 */

import { afterAll, afterEach, beforeEach, describe, expect, test } from "bun:test";
import * as path from "node:path";
import { cleanupTempDirs, tempDir } from "../../tests/temp-dirs";
import { PermissionManager } from "./index";
import { _resetTuiApprovalChannel, registerTuiApprovalHandler } from "./tui-approval-channel";

afterAll(cleanupTempDirs);

const savedHeadless = process.env.EIGHT_HEADLESS;
const savedTTY = process.stdin.isTTY;

beforeEach(() => {
	delete process.env.EIGHT_HEADLESS;
});
afterEach(() => {
	if (savedHeadless === undefined) delete process.env.EIGHT_HEADLESS;
	else process.env.EIGHT_HEADLESS = savedHeadless;
	(process.stdin as { isTTY?: boolean }).isTTY = savedTTY;
	_resetTuiApprovalChannel();
});

function manager(): PermissionManager {
	const dir = tempDir("always-blocked-");
	return new PermissionManager(path.join(dir, "permissions.json"));
}

// The destructive part is assembled so no line of this file is itself one.
const WIPE = ["rm", "-rf", "/"].join(" ");
const PERMS = ["chmod", "-R", "000", "/"].join(" ");

const BLOCKED_LINES = [
	WIPE,
	`ls && ${WIPE}`,
	`echo hi; ${WIPE}`,
	`false || ${WIPE}`,
	`cat notes | ${WIPE}`,
	`echo a\n${WIPE}`,
	`cd /tmp && echo ok && ${PERMS}`,
	`sudo ${WIPE}`,
	`env FOO=1 ${WIPE}`,
	`timeout 5 ${WIPE}`,
	`echo ok; xargs ${WIPE}`,
	`sh -c 'ls && ${WIPE}'`,
	`ls && /bin/${WIPE}`,
	"ls && dd if=/dev/zero of=/dev/sda",
];

const ORDINARY_LINES = [
	"git status && bun test",
	"cd packages && ls | wc -l",
	"echo a; echo b",
	"false || echo fallback",
	"git log --oneline\ngit diff --stat",
	`echo '${WIPE}' is a dangerous command`,
	"grep -rf patterns.txt src",
];

describe("always-blocked segments (#3768)", () => {
	test("the check sees a blocked command in any position", () => {
		const pm = manager();
		for (const line of BLOCKED_LINES) {
			expect([line, pm.checkPermission(line)]).toEqual([line, "denied"]);
		}
	});

	test("ordinary multi-command lines are not blocked", () => {
		const pm = manager();
		for (const line of ORDINARY_LINES) {
			expect([line, pm.checkPermission(line)]).not.toEqual([line, "denied"]);
		}
	});

	test("ask mode: refused without ever reaching the person", async () => {
		(process.stdin as { isTTY?: boolean }).isTTY = true;
		const asked: string[] = [];
		registerTuiApprovalHandler(async (req) => {
			asked.push(req.command ?? "");
			return "approve";
		});
		const pm = manager();
		for (const line of BLOCKED_LINES) {
			expect([line, await pm.requestPermission("Execute Shell Command", "d", line)]).toEqual([
				line,
				false,
			]);
		}
		expect(asked).toEqual([]);
	});

	test("auto mode: refused even with auto-approve on", async () => {
		(process.stdin as { isTTY?: boolean }).isTTY = true;
		const pm = manager();
		pm.setAutoApprove(true);
		for (const line of BLOCKED_LINES) {
			expect([line, await pm.requestPermission("Execute Shell Command", "d", line)]).toEqual([
				line,
				false,
			]);
		}
	});

	test("run mode (no terminal): refused", async () => {
		process.env.EIGHT_HEADLESS = "1";
		const pm = manager();
		const log = console.log;
		console.log = () => {};
		try {
			for (const line of BLOCKED_LINES) {
				expect([line, await pm.requestPermission("Execute Shell Command", "d", line)]).toEqual([
					line,
					false,
				]);
			}
		} finally {
			console.log = log;
		}
	});

	test("Infinite mode: refused and audited", async () => {
		const pm = manager();
		pm.enableInfiniteMode();
		const log = console.log;
		console.log = () => {};
		try {
			for (const line of BLOCKED_LINES) {
				expect([line, pm.checkPermission(line)]).toEqual([line, "denied"]);
				expect([line, await pm.requestPermission("Execute Shell Command", "d", line)]).toEqual([
					line,
					false,
				]);
			}
			expect(pm.getInfiniteModeAuditLog().every((e) => e.blocked)).toBe(true);
		} finally {
			console.log = log;
			pm.disableInfiniteMode();
		}
	});

	test("ordinary multi-command lines still run in Infinite and auto mode", async () => {
		(process.stdin as { isTTY?: boolean }).isTTY = true;
		const pm = manager();
		pm.enableInfiniteMode();
		const log = console.log;
		console.log = () => {};
		try {
			for (const line of ORDINARY_LINES) {
				expect([line, await pm.requestPermission("Execute Shell Command", "d", line)]).toEqual([
					line,
					true,
				]);
			}
		} finally {
			console.log = log;
			pm.disableInfiniteMode();
		}
		const auto = manager();
		auto.setAutoApprove(true);
		for (const line of ["git status && bun test", "echo a; echo b"]) {
			expect(await auto.requestPermission("Execute Shell Command", "d", line)).toBe(true);
		}
	});
});
