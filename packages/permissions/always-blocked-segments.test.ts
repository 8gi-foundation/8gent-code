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
const WIPE_STAR = ["rm", "-rf", "/*"].join(" ");
const CHOWN_ROOT = ["chown", "-R", "me:me", "/"].join(" ");
const DISK = ["dd", "if=/dev/zero", "of=/dev/disk2"].join(" ");

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
	// exact-target spellings
	"rm -fr /",
	"rm -r -f /",
	"rm --recursive --force /",
	`rm -rf "/"`,
	"rm -rf //",
	WIPE_STAR,
	CHOWN_ROOT,
	"chown -R me:me /etc",
	"chown -R me /usr",
	"chown -R me /System",
	"chmod -R 755 /",
	DISK,
	"mkfs.ext4 /dev/sda1",
	// command substitution, subshells, groups, bodies
	`echo $(${WIPE})`,
	`echo "$(${WIPE})"`,
	`echo \`${WIPE}\``,
	`(${WIPE})`,
	`(cd /tmp; ${WIPE})`,
	`{ ${WIPE}; }`,
	`if true; then ${WIPE}; fi`,
	`for x in a b; do ${WIPE}; done`,
	`while true; do ${WIPE}; done`,
	`diff <(${WIPE}) /dev/null`,
	// text piped into a shell is executed
	`echo '${WIPE}' | sh`,
	`echo '${WIPE}' | bash`,
	`printf '%s' '${WIPE}' | sudo zsh`,
	// backslash-newline continuation
	"rm \\\n -rf /",
	"echo ok && rm -rf \\\n/",
	// wrappers
	`busybox ${WIPE}`,
	`doas ${WIPE}`,
	`su -c '${WIPE}'`,
	`su root -c "${WIPE}"`,
	`ssh host ${WIPE}`,
	`ssh host '${WIPE}'`,
	`parallel ${WIPE} ::: x`,
	`watch -n 1 '${WIPE}'`,
	`watch ${WIPE}`,
	`setsid ${WIPE}`,
	`flock /tmp/lock ${WIPE}`,
	`flock /tmp/lock -c '${WIPE}'`,
	`eval ${WIPE}`,
];

const ORDINARY_LINES = [
	"git status && bun test",
	"cd packages && ls | wc -l",
	"echo a; echo b",
	"false || echo fallback",
	"git log --oneline\ngit diff --stat",
	`echo '${WIPE}' is a dangerous command`,
	"grep -rf patterns.txt src",
	"rm -rf /tmp/build",
	"rm -rf /Users/x/proj/dist",
	"rm -rf ./dist node_modules",
	"rm -r -f /var/tmp/cache",
	"chown -R me:me ./dir",
	"chown -R me:me /Users/x/proj",
	"chown me:me /etc/hosts",
	"chmod -R 755 ./scripts",
	"chmod 644 /etc/hosts",
	"dd if=a.img of=b.img",
	"dd if=/dev/zero of=/tmp/file bs=1m count=1",
	"mkfs.ext4 disk.img",
	"echo $(date) && ls",
	"(cd packages && ls)",
	"{ echo a; echo b; }",
	"for f in a b; do echo $f; done",
	"if true; then echo yes; fi",
	"echo hello | sh",
	"cat notes.txt | bash",
	"ssh host ls -la",
	"busybox ls",
	"flock /tmp/lock git status",
	"echo ok \\\n && ls",
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

	test("every mode audits its refusals", async () => {
		const log = console.log;
		console.log = () => {};
		try {
			(process.stdin as { isTTY?: boolean }).isTTY = true;
			const ask = manager();
			await ask.requestPermission("Execute Shell Command", "d", WIPE);
			const auto = manager();
			auto.setAutoApprove(true);
			await auto.requestPermission("Execute Shell Command", "d", `ls && ${WIPE}`);
			process.env.EIGHT_HEADLESS = "1";
			const run = manager();
			await run.requestPermission("Execute Shell Command", "d", `echo $(${WIPE})`);
			const modes = [ask, auto, run].map((pm) => {
				const entries = pm.getInfiniteModeAuditLog();
				expect(entries.length).toBe(1);
				expect(entries[0].blocked).toBe(true);
				return entries[0].mode;
			});
			expect(modes).toEqual(["ask", "auto", "run"]);
		} finally {
			console.log = log;
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
