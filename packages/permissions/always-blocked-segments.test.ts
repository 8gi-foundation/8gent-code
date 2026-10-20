/**
 * #3768: the always-blocked check covers every command on a line, not only the
 * first. A line with an always-blocked segment in any position is refused in
 * every mode; ordinary multi-command lines still run.
 */

import { afterAll, afterEach, beforeEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
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

// Home-directory wipes (#4485), assembled so no line of this file is itself one.
const RMRF = ["rm", "-rf"].join(" ");
const HOME_DIR = os.homedir();
const HOME_REAL = fs.realpathSync(HOME_DIR);
const HOME_LINES = [
	`${RMRF} ~`,
	`${RMRF} ~/`,
	`${RMRF} ~/*`,
	`${RMRF} $HOME`,
	`${RMRF} ` + "${HOME}",
	`${RMRF} "$HOME"`,
	`${RMRF} "$HOME"/`,
	`${RMRF} $HOME/`,
	`${RMRF} $HOME/*`,
	`${RMRF} ${HOME_DIR}`,
	`${RMRF} ${HOME_DIR}/`,
	`${RMRF} ${HOME_DIR}/*`,
	`${RMRF} ${HOME_REAL}`,
	"rm -fr ~",
	"rm -r -f ~",
	"rm -r ~",
	"rm --recursive --force ~",
	`echo hi; ${RMRF} ~`,
	`true && ${RMRF} $HOME`,
	`false || ${RMRF} "$HOME"/`,
	`ls\n${RMRF} ~`,
	`sudo ${RMRF} ~`,
	`sh -c '${RMRF} ~'`,
];

const BLOCKED_LINES = [
	...HOME_LINES,
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
	"rm -rf ~/some/subdir",
	"rm -rf $HOME/some/subdir",
	'rm -rf "$HOME"/some/subdir',
	`rm -rf ${HOME_DIR}/some/subdir`,
	"rm ~/notes.txt",
	"ls ~ && echo done",
	"echo hi; echo $HOME",
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

// Not blocked, but asks the person every time by policy (#3806): excluded from the unattended-run check only.
const ASKS_BY_POLICY = new Set(["ssh host ls -la"]);

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
			// #3806: a remote command (ssh) now asks every time by policy, so it cannot run unattended here.
			for (const line of ORDINARY_LINES.filter((l) => !ASKS_BY_POLICY.has(l))) {
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

describe("chained lines are judged per segment (#4485)", () => {
	const pm = manager();

	test("isDangerous sees a dangerous command in any segment", () => {
		for (const line of [
			"echo hi; rm -rf ./dist",
			"true && rm -rf ~/some/subdir",
			"false || rm -rf build",
			"ls | rm -rf x",
			"echo a\nrm -rf build",
		]) {
			expect([line, pm.isDangerous(line)]).toEqual([line, true]);
		}
		// the bare form was already dangerous
		expect(pm.isDangerous("rm -rf build")).toBe(true);
	});

	test("a harmless chained line is not dangerous and still passes", () => {
		for (const line of ["git status && ls", "echo a; echo b", "cat x | wc -l"]) {
			expect([line, pm.isDangerous(line)]).toEqual([line, false]);
			expect([line, pm.checkPermission(line)]).toEqual([line, "allowed"]);
		}
	});

	test("a dangerous segment makes the line ask, never allowed", () => {
		for (const line of ["echo hi; rm -rf ./dist", "true && rm -rf ~/some/subdir"]) {
			expect([line, pm.checkPermission(line)]).toEqual([line, "ask"]);
		}
	});

	test("headless: a dangerous chained line is refused like the bare form", async () => {
		process.env.EIGHT_HEADLESS = "1";
		const log = console.log;
		console.log = () => {};
		try {
			for (const line of [
				"rm -rf ./dist",
				"echo hi; rm -rf ./dist",
				"true && rm -rf ~/some/subdir",
				"echo hi; rm -rf ~",
				"true && rm -rf $HOME",
			]) {
				expect([line, await pm.requestPermission("Execute Shell Command", "d", line)]).toEqual([
					line,
					false,
				]);
			}
			expect(await pm.requestPermission("Execute Shell Command", "d", "echo a; echo b")).toBe(true);
		} finally {
			console.log = log;
		}
	});

	test("interactive: a home wipe is never offered to the person", async () => {
		(process.stdin as { isTTY?: boolean }).isTTY = true;
		const asked: string[] = [];
		registerTuiApprovalHandler(async (req) => {
			asked.push(req.command ?? "");
			return "approve";
		});
		for (const line of ["echo hi; rm -rf ~", "true && rm -rf $HOME"]) {
			expect([line, await pm.requestPermission("Execute Shell Command", "d", line)]).toEqual([
				line,
				false,
			]);
		}
		expect(asked).toEqual([]);
	});
});
