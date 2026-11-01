/**
 * 8SO second read of the script-body check: launch shapes that must never come back "none"
 * (judged by the command text alone). Static: scriptLaunch only reads files, nothing runs.
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { cleanupTempDirs, tempDir } from "../../tests/temp-dirs";
import { scriptLaunch } from "./s1-script-body";

afterAll(cleanupTempDirs);

let dir = "";
beforeAll(() => {
	dir = tempDir("s1-second-read-");
	writeFileSync(join(dir, "ok.sh"), "echo hello\n");
	writeFileSync(join(dir, "evil.sh"), "echo MARK_HIGH\n");
});

const kind = (cmd: string) => scriptLaunch(cmd, dir, dir).kind;

describe("shapes already read (control)", () => {
	for (const cmd of [
		"(bash evil.sh)",
		"( bash evil.sh )",
		"{ bash evil.sh; }",
		"if true; then bash evil.sh; fi",
		"for i in 1; do bash evil.sh; done",
		"f() { bash evil.sh; }; f",
		"echo $(bash evil.sh)",
		"bash evil.sh &",
		"ba''sh evil.sh",
		"\\bash evil.sh",
		"time -p bash evil.sh",
		"nohup sh -c 'bash evil.sh'",
		"sudo -E bash evil.sh",
		"env -S 'bash evil.sh'",
		"setsid bash evil.sh",
		"echo evil.sh | xargs bash",
		"bash < evil.sh",
		"cat evil.sh | sh",
		"bash <(cat evil.sh)",
		'eval "$(cat evil.sh)"',
		'bash -c "$(cat evil.sh)"',
		"$SHELL evil.sh",
		"exec -a x bash evil.sh",
	]) {
		test(cmd, () => expect(kind(cmd)).not.toBe("none"));
	}
});

describe("8SO second read: shapes that come back none", () => {
	// A shell started with BASH_ENV (or ENV, ZDOTDIR) reads that file first, unread.
	for (const cmd of [
		"BASH_ENV=evil.sh bash -c true",
		"BASH_ENV=evil.sh bash ok.sh",
		"env BASH_ENV=evil.sh bash -c true",
		"export BASH_ENV=evil.sh; bash -c true",
		"ZDOTDIR=. zsh -c true",
	]) {
		test(`startup file: ${cmd}`, () => expect(kind(cmd)).not.toBe("none"));
	}
	// A non-inert program handed a shell and a file that does not exist yet at check time.
	test("file created in the same line, run through setsid", () =>
		expect(kind("printf x > new.sh; setsid sh new.sh")).not.toBe("none"));
	// Command text handed to a program as one word.
	for (const cmd of [
		"trap 'bash evil.sh' EXIT",
		"flock /tmp/l -c 'bash evil.sh'",
		"script -q /dev/null -c 'bash evil.sh'",
	]) {
		test(`command text: ${cmd}`, () => expect(kind(cmd)).not.toBe("none"));
	}
	test("body that sets BASH_ENV then starts a shell", () => {
		writeFileSync(join(dir, "chain.sh"), "export BASH_ENV=evil.sh\nbash -c true\n");
		expect(kind("bash chain.sh")).toBe("unchecked");
	});
});
