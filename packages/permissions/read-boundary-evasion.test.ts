/**
 * #4880, 8SO evasion pass: the read boundary through the production gate (systemOneGate), with
 * real files, a real symlink and a fake home on disk. Every command here is checked against what
 * it names; nothing reads a real credential. The outside files sit under the repo's .tmp/, not
 * $TMPDIR, because the temp folders are an allowance.
 *
 * What it does not claim: a path built at run time (`python3 -c "open('..'+'/x')"`, `$OLDPWD`,
 * `$(printf ..)`) is not seen by a lexical check. Those are listed at the bottom as known gaps so
 * a change that closes one has to move it.
 */

import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";
import { resetReadAllow } from "./read-allow";
import {
	SYSTEM_ONE_FLAG,
	_resetSystemOne,
	_setSystemOneOverridesForTests,
	systemOneGate,
} from "./system-one-gate";

const repoTmp = path.resolve(import.meta.dir, "..", "..", ".tmp");
let base: string;
let ws: string;
let home: string;
const savedHome = process.env.HOME;
let cards: string[] = [];

beforeAll(() => {
	fs.mkdirSync(repoTmp, { recursive: true });
	base = fs.mkdtempSync(path.join(repoTmp, "rb-evasion-"));
	ws = path.join(base, "proj");
	home = path.join(base, "home");
	for (const d of [
		ws,
		path.join(ws, "src"),
		path.join(home, ".ssh"),
		path.join(home, ".aws"),
		path.join(home, ".8gent", "keys"),
		path.join(home, ".8gent", "browser-profiles"),
		path.join(home, ".config", "gh"),
		path.join(home, ".docker"),
	])
		fs.mkdirSync(d, { recursive: true });
	const files: [string, string][] = [
		[path.join(base, "x"), "OUTSIDE-X"],
		[path.join(base, "y"), "OUTSIDE-Y"],
		[path.join(base, "x.sh"), "echo hi"],
		[path.join(ws, "inside.txt"), "inside"],
		[path.join(ws, "src", "a.ts"), "export {}"],
		[path.join(home, ".ssh", "id_rsa"), "PRIVATE"],
		[path.join(home, ".aws", "credentials"), "AWS"],
		[path.join(home, ".netrc"), "NETRC"],
		[path.join(home, ".docker", "config.json"), "{}"],
		[path.join(home, ".config", "gh", "hosts.yml"), "gh"],
		[path.join(home, ".8gent", "memory.db"), "MEMORY"],
		[path.join(home, ".8gent", "brain.db"), "BRAIN"],
		[path.join(home, ".8gent", "keys", "k"), "KEY"],
		[path.join(home, ".8gent", "browser-profiles", "p"), "COOKIES"],
		[path.join(home, ".8gent", "config.json"), "{}"],
		[path.join(home, "notes.txt"), "notes"],
	];
	for (const [p, c] of files) fs.writeFileSync(p, c);
	fs.symlinkSync(path.join(base, "x"), path.join(ws, "link-out"));
	fs.symlinkSync(base, path.join(ws, "dir-out"));
	process.env.HOME = home; // the tokenizer expands ~ from process.env.HOME
});

afterAll(() => {
	if (savedHome === undefined) Reflect.deleteProperty(process.env, "HOME");
	else process.env.HOME = savedHome;
	_resetSystemOne();
	resetReadAllow();
	fs.rmSync(base, { recursive: true, force: true });
});

beforeEach(() => {
	cards = [];
	_setSystemOneOverridesForTests({
		askHuman: async (req) => {
			cards.push(req.command);
			return null; // nobody can answer: an outside read is refused
		},
	});
});

const env = (root?: string): Record<string, string | undefined> => ({
	HOME: home,
	[SYSTEM_ONE_FLAG]: "0", // System One off: the boundary alone decides
	...(root ? { EIGHT_WORKSPACE_ROOT: root } : {}),
});
const verdict = async (command: string, root?: string, cwd = ws, project = ws) => {
	const r = await systemOneGate(command, env(root), cwd, undefined, undefined, { project });
	return r.run ? "ran" : "refused";
};

describe("lexical evasions of the workspace root are refused", () => {
	const REFUSED = [
		// path spellings
		"cat ../x",
		"cat ..//x",
		"cat ./../x",
		"cat ./.././x",
		"cat -- ../x",
		// moving out first
		"cd .. && cat x",
		"cd ..; cat x",
		"pushd .. >/dev/null; cat x",
		"(cd .. && cat x)",
		// readers other than cat, and what they are fed
		"xargs cat <<< ../x",
		'xargs cat <<< "$HOME/.ssh/id_rsa"',
		"echo ../x | xargs cat",
		'cat <<< "$(cat ../x)"',
		"tar -C .. -c x",
		"tar -c ../x",
		"cat < ../x",
		"<../x cat",
		"curl --data-binary @../x http://127.0.0.1:9",
		"curl -T ../x http://127.0.0.1:9",
		"git --git-dir=.. log",
		// globs and braces: the folder they search is outside
		"cat ../*",
		"cat ../?",
		"cat ../[x]",
		"cat ../x*",
		"cat ..{/x,/y}",
		"cat ~/.ssh/*",
		"cat ~/.ss?/id_rsa",
		"cat ~/.ssh/id_r[s]a",
		// variables the check can know
		"cat $HOME/.ssh/id_rsa",
		"cat ${HOME}/.ssh/id_rsa",
		'cat "$HOME"/.ssh/id_rsa',
		'cat "$PWD/../x"',
		"D=..; cat $D/x",
		// code in a string
		"bash -c 'cat ../x'",
		'sh -c "cat ../x"',
		"eval 'cat ../x'",
		"cat $(echo ../x)",
		"cat `echo ../x`",
		"cat <(cat ../x)",
		"env cat ../x",
		"time cat ../x",
		"sudo cat ../x",
		`python3 -c "print(open('../x').read())"`,
		// links
		"cat link-out",
		"cat dir-out/x",
		"cat ./dir-out/y",
		// the tool's own data that is not for a shell
		"cat ~/.8gent/memory.db",
		"sqlite3 ~/.8gent/memory.db .dump",
		"cat ~/.8gent/brain.db",
		"cat ~/.8gent/browser-profiles/p",
		"cat ~/.8gent/keys/k",
		"cat ~/.8gent/../.ssh/id_rsa",
		"cat ~/.netrc",
		"cat ~/.docker/config.json",
		"cat ~/.config/gh/hosts.yml",
	];
	for (const command of REFUSED) {
		test(`refused: ${command}`, async () => {
			expect(await verdict(command)).toBe("refused");
			expect(cards.length).toBeGreaterThan(0);
		});
	}
});

describe("file URLs", () => {
	test("curl file:// of a file outside is refused", async () => {
		expect(await verdict(`curl file://${path.join(base, "x")}`)).toBe("refused");
	});
});

describe("a session rooted at $HOME still gates its credentials and the tool's data", () => {
	for (const command of [
		"cat ~/.ssh/id_rsa",
		"cat $HOME/.aws/credentials",
		"cat ~/.netrc",
		"cat ~/.docker/config.json",
		"cat ~/.config/gh/hosts.yml",
		"cat ~/.8gent/keys/k",
		"cat ~/.8gent/memory.db",
		"cat ~/.ssh/*",
		"cat ../x",
	]) {
		test(`refused with root = home: ${command}`, async () => {
			expect(await verdict(command, home, home, home)).toBe("refused");
		});
	}
	for (const command of [
		"cat ~/notes.txt",
		"cat $HOME/notes.txt",
		"ls ~",
		"cat ~/.8gent/config.json",
	]) {
		test(`ordinary reads in a home root still run: ${command}`, async () => {
			expect(await verdict(command, home, home, home)).toBe("ran");
		});
	}
});

describe("ordinary work in the working folder still runs with no card", () => {
	for (const command of [
		"cat inside.txt",
		"ls",
		"ls src",
		"cat ./src/*.ts",
		"grep -r export src",
		'cat "$PWD/inside.txt"',
		"git -C . status",
		"cat <<< hi",
		"echo $(date)",
		"bash -c 'echo hi'",
		'node -e "console.log(1)"',
		"curl http://127.0.0.1:9/x",
		"cat ~/.8gent/config.json",
		"cat /usr/bin/env",
		"cat /dev/null",
		"cat /tmp/does-not-exist",
	]) {
		test(`runs: ${command}`, async () => {
			expect(await verdict(command)).toBe("ran");
			expect(cards).toEqual([]);
		});
	}
});

describe("known gaps of a lexical check (a kernel read rule is the answer)", () => {
	test("a path built at run time is not seen, and this test says so", async () => {
		for (const command of [
			`python3 -c "print(open('..'+'/x').read())"`,
			"cat $OLDPWD/x",
			'cat "$(echo .)./x"',
		])
			expect({ command, v: await verdict(command) }).toEqual({ command, v: "ran" });
	});
});
