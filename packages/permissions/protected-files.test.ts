/**
 * Agent-protected files at the OS layer (#3595). No agent-run shell command
 * may change ~/.8gent/settings.json or ~/.8gent/post-message-confirmed.json,
 * however the path is spelled, so a post_message recipient cannot be granted
 * from the shell for the next launch.
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
	test("denies writes to both files and unlink of their directory, nothing else", () => {
		const profile = buildProtectedFilesProfile([
			"/h/.8gent/settings.json",
			"/h/.8gent/post-message-confirmed.json",
		]);
		expect(profile).toContain("(allow default)");
		expect(profile).toContain(
			'(deny file-write* (literal "/h/.8gent/settings.json") (literal "/h/.8gent/post-message-confirmed.json"))',
		);
		expect(profile).toContain('(deny file-write-unlink (literal "/h/.8gent"))');
		expect(profile).not.toContain("file-read");
	});

	test("the default list is the two files under the home's .8gent", () => {
		withEnv("EIGHT_FAKE_HOME", "/fake/home", () => {
			expect(protectedAgentFiles()).toEqual([
				"/fake/home/.8gent/settings.json",
				"/fake/home/.8gent/post-message-confirmed.json",
			]);
		});
	});

	test("EIGHT_SEATBELT=0 leaves the command unwrapped (confirmation then rests on System One)", () => {
		withEnv("EIGHT_SEATBELT", "0", () => {
			expect(wrapShellCommand("echo hi")).toBe("echo hi");
		});
	});
});

describe("run_command backstop", () => {
	test("names of either file are refused, other .8gent files are not", () => {
		for (const c of [
			"echo x > ~/.8gent/settings.json",
			"tee $HOME/.8gent/post-message-confirmed.json",
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
	const confirmed = path.join(home, ".8gent", "post-message-confirmed.json");
	const original = JSON.stringify({ postMessage: { allowedChats: ["-1"] } });
	const savedHome = process.env.EIGHT_FAKE_HOME;

	beforeAll(() => {
		fs.mkdirSync(path.join(home, ".8gent"));
		fs.writeFileSync(settings, original);
		fs.writeFileSync(confirmed, '["-1"]');
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

	test("the files cannot be rewritten, replaced or unlinked, and the directory cannot be moved aside", () => {
		for (const cmd of [
			`echo '["-9"]' > ${confirmed}`,
			`unlink ${confirmed}`,
			`mv ${confirmed} ${confirmed}.bak`,
			`mv ${home}/.8gent ${home}/.8gent-old`,
			`python3 -c "open('${settings}','w').write('{}')"`,
		]) {
			expect(run(cmd).status).not.toBe(0);
		}
		expect(fs.readFileSync(confirmed, "utf8")).toBe('["-1"]');
		expect(fs.readFileSync(settings, "utf8")).toBe(original);
		expect(fs.existsSync(path.join(home, ".8gent"))).toBe(true);
	});

	test("everything else still works: other files in .8gent, reads of the protected files", () => {
		expect(run(`echo ok > ${home}/.8gent/other.txt && cat ${settings}`).stdout).toContain(
			"allowedChats",
		);
	});

	test("next launch: the allowlist still lacks the chat the command tried to add", async () => {
		run(`echo '{"postMessage":{"allowedChats":["-1","-666"]}}' > ${settings}`);
		const { readAllowedChats } = await import("../ai/post-message");
		withEnv("HOME", home, () => {
			expect(readAllowedChats()).toEqual(["-1"]);
		});
	});
});
