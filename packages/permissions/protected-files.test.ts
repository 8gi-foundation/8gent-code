/**
 * Agent-protected settings file at the OS layer (#3602, #3595). No agent-run
 * shell command may change ~/.8gent/settings.json, however the path is
 * spelled, so a post_message recipient cannot be granted from the shell.
 *
 * The profile tests are pure. The live tests need a process the host has not
 * already sandboxed (sandbox-exec cannot nest): inside the agent's own
 * sandbox they skip, and they run in a normal terminal.
 */

import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import {
	buildProtectedFilesProfile,
	canApplyProfile,
	isSeatbeltAvailable,
	protectedAgentFiles,
	touchesProtectedAgentFile,
	wrapShellCommand,
} from "./seatbelt";

function withEnv(key: string, value: string, fn: () => void) {
	const saved = process.env[key];
	process.env[key] = value;
	try {
		fn();
	} finally {
		if (saved === undefined) Reflect.deleteProperty(process.env, key);
		else process.env[key] = saved;
	}
}

describe("protected agent files profile", () => {
	test("denies writes to the file and unlink of its directory, nothing else", () => {
		const profile = buildProtectedFilesProfile(["/h/.8gent/settings.json"]);
		expect(profile).toContain("(allow default)");
		expect(profile).toContain('(deny file-write* (literal "/h/.8gent/settings.json"))');
		expect(profile).toContain('(deny file-write-unlink (literal "/h/.8gent"))');
		expect(profile).not.toContain("file-read");
	});

	test("the default list is settings.json under the home's .8gent", () => {
		withEnv("EIGHT_FAKE_HOME", "/fake/home", () => {
			expect(protectedAgentFiles()).toEqual(["/fake/home/.8gent/settings.json"]);
		});
	});

	test("EIGHT_SEATBELT=0 leaves the command unwrapped", () => {
		withEnv("EIGHT_SEATBELT", "0", () => {
			expect(wrapShellCommand("echo hi")).toBe("echo hi");
		});
	});
});

describe("run_command backstop", () => {
	test("names of the file are refused, other .8gent files are not", () => {
		for (const c of [
			"echo x > ~/.8gent/settings.json",
			"tee $HOME/.8gent/settings.json",
			"cat .8gent / settings.json",
			"cp a '.8gent/'settings.json",
		])
			expect(touchesProtectedAgentFile(c)).toBe(true);
		for (const c of ["ls ~/.8gent/logs", "cat ~/.8gent/other.json", "echo settings.json"])
			expect(touchesProtectedAgentFile(c)).toBe(false);
	});
});

describe.if(isSeatbeltAvailable() && canApplyProfile())("protected agent files, live", () => {
	const home = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "sb-prot-")));
	const settings = path.join(home, ".8gent", "settings.json");
	const original = JSON.stringify({ postMessage: { allowedChats: ["-1"] } });
	const savedHome = process.env.EIGHT_FAKE_HOME;

	beforeAll(() => {
		fs.mkdirSync(path.join(home, ".8gent"));
		fs.writeFileSync(settings, original);
		process.env.EIGHT_FAKE_HOME = home;
	});
	afterAll(() => {
		if (savedHome === undefined) Reflect.deleteProperty(process.env, "EIGHT_FAKE_HOME");
		else process.env.EIGHT_FAKE_HOME = savedHome;
		fs.rmSync(home, { recursive: true, force: true });
	});

	const run = (cmd: string) =>
		spawnSync("/bin/sh", ["-c", wrapShellCommand(cmd)], { encoding: "utf8" });

	test("an obfuscated sh -c write to settings.json fails and the file is unchanged", () => {
		const r = run(`sh -c 'echo X > ${home}/.8"gent"/settings.json'`);
		expect(r.status).not.toBe(0);
		expect(fs.readFileSync(settings, "utf8")).toBe(original);
	});

	test("the file cannot be rewritten, replaced or removed, and the directory cannot be moved aside", () => {
		for (const cmd of [
			`echo '{}' > ${settings}`,
			`unlink ${settings}`,
			`mv ${settings} ${settings}.bak`,
			`mv ${home}/.8gent ${home}/.8gent-old`,
			`python3 -c "open('${settings}','w').write('{}')"`,
		]) {
			expect(run(cmd).status).not.toBe(0);
		}
		expect(fs.readFileSync(settings, "utf8")).toBe(original);
		expect(fs.existsSync(path.join(home, ".8gent"))).toBe(true);
	});

	test("everything else still works: other files in .8gent, reads of the protected file", () => {
		expect(run(`echo ok > ${home}/.8gent/other.txt && cat ${settings}`).stdout).toContain(
			"allowedChats",
		);
	});
});
