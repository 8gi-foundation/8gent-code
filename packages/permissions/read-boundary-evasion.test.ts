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
import { DEFAULT_READ_ALLOWANCES } from "./read-boundary";
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
		path.join(base, "outside"),
	])
		fs.mkdirSync(d, { recursive: true });
	const files: [string, string][] = [
		[path.join(base, "x"), "OUTSIDE-X"],
		[path.join(base, "y"), "OUTSIDE-Y"],
		[path.join(base, "x.sh"), "echo hi"],
		[path.join(ws, "inside.txt"), "inside"],
		[path.join(ws, "package.json"), "{}"],
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
		[path.join(base, "outside", "secret.txt"), "SECRET"],
		[path.join(ws, "sedscript"), "r ../outside/secret.txt\n"],
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

/**
 * What the kernel never lets a read through (#4897): refused with no card, because a yes changes
 * nothing. Every other outside path still gets its card.
 */
const NEVER_READ =
	/\.ssh[/*]|\.netrc|\.docker\/config|\.config\/gh|\.8gent\/(memory|brain|browser|keys)/;
const cardsFor = (command: string) =>
	NEVER_READ.test(command) ? expect(cards.length).toBe(0) : expect(cards.length).toBeGreaterThan(0);

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
			cardsFor(command);
		});
	}
});

describe("second-read holes: ANSI-C quoting, awk and the other script runners", () => {
	const REFUSED = [
		// $'...' and $"..." quoting, decoded before the scan
		"cat $'../x'",
		"cat $'..\\x2fx'",
		"cat $'\\x2e\\x2e/x'",
		"cat $'\\056\\056/x'",
		'cat $"../x"',
		"bash -c $'cat ../x'",
		"cat <$'../x'",
		// awk family: the program string, its getline and output redirects, -f, -v, file operands
		`awk 'BEGIN{while((getline l<"../x")>0)print l}'`,
		`gawk 'BEGIN{while((getline l<"../x")>0)print l}'`,
		`mawk 'BEGIN{while((getline l<"../x")>0)print l}'`,
		`nawk 'BEGIN{while((getline l<"../x")>0)print l}'`,
		`awk 'BEGIN{"cat ../x" | getline l; print l}'`,
		`awk 'BEGIN{system("cat ../x")}'`,
		`awk 'BEGIN{print "data" > "../y"}'`,
		"awk -f ../x.sh",
		"awk -f../x.sh",
		"awk '{print}' ../x",
		"awk -v f=../x 'BEGIN{while((getline l<f)>0)print l}'",
		// jq and sed file operands
		"jq . ../x",
		"jq -n --rawfile a ../x '$a'",
		"jq -n --slurpfile a ../x '$a'",
		"sed -f ../x.sh inside.txt",
		"sed -f../x.sh inside.txt",
		"sed -n p ../x",
		// env -S runs a string as a command
		"env -S 'cat ../x'",
		'env -S"cat ../x"',
		"env --split-string='cat ../x'",
		// busybox applets
		"busybox cat ../x",
		"busybox awk '{print}' ../x",
		"busybox sh -c 'cat ../x'",
		"busybox ash -c 'cat ../x'",
		// tclsh, lua, R
		"echo 'puts [read [open ../x]]' | tclsh",
		"tclsh <<< 'puts [read [open ../x]]'",
		`lua -e 'print(io.open("../x"):read("a"))'`,
		`Rscript -e 'cat(readLines("../x"))'`,
	];
	for (const command of REFUSED) {
		test(`refused: ${command}`, async () => {
			expect(await verdict(command)).toBe("refused");
			expect(cards.length).toBeGreaterThan(0);
		});
	}

	test("awk getline of the memory database is refused in a home-rooted session", async () => {
		const db = path.join(home, ".8gent", "memory.db");
		const command = `awk 'BEGIN{while((getline l<"${db}")>0)print l}'`;
		expect(await verdict(command, home, home, home)).toBe("refused");
		expect(cards.length).toBe(0); // the private data set: never read, so no card (#4897)
	});

	test("inline python reading the memory database is refused in a home-rooted session", async () => {
		const db = path.join(home, ".8gent", "memory.db");
		expect(await verdict(`python3 -c "open('${db}').read()"`, home, home, home)).toBe("refused");
	});

	for (const command of [
		"awk '{print $1}' inside.txt",
		"awk -F, '{print $2}' src/a.ts",
		"awk '/^export/ {print}' src/a.ts",
		"awk 'BEGIN{print 1/2}'",
		"awk -f ./src/a.ts inside.txt",
		"git log",
		"rg export",
		"cat *.json",
		"jq . package.json",
		"sed -n 1p inside.txt",
		"cat $'inside.txt'",
		"env -S 'echo hi'",
		"busybox ls",
		"lua -e 'print(1)'",
		"Rscript -e 'print(1)'",
		"cc -I/usr/include -o/dev/null x.c",
	]) {
		test(`runs: ${command}`, async () => {
			expect(await verdict(command)).toBe("ran");
			expect(cards).toEqual([]);
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

describe("interpreter program text is scanned by class, not by well-formed quoted path", () => {
	const REFUSED = [
		// awk concatenates adjacent string literals at run time
		`awk 'BEGIN{while((getline l<".."\x22/outside/secret.txt\x22)>0)print l}'`,
		// awk string escapes: \. and \/ decode away before the path is seen
		`awk 'BEGIN{while((getline l<"\\.\\./outside/secret.txt")>0)print l}'`,
		`awk 'BEGIN{while((getline l<"\\x2e\\x2e/outside/secret.txt")>0)print l}'`,
		// sed r/R/w filename commands, with and without a space
		`sed -n 'r ../outside/secret.txt' package.json`,
		`sed -e 'r ../outside/secret.txt'`,
		`sed 'R../outside/secret.txt' package.json`,
		`sed -n 'w ../outside/secret.txt' package.json`,
	];
	for (const command of REFUSED) {
		test(`refused: ${command}`, async () => {
			expect(await verdict(command)).toBe("refused");
			expect(cards.length).toBeGreaterThan(0);
		});
	}

	// Programs that merely mention a harmless pattern must still run with no card.
	for (const command of [
		"awk '{print $1}' inside.txt",
		"awk -F, '{print $2}' src/a.ts",
		"awk 'BEGIN{print 1/2}'",
		"sed -n 1p inside.txt",
		"sed 's/a/b/' inside.txt",
		"sed -e 's/x/y/' inside.txt",
		"git log",
	]) {
		test(`runs: ${command}`, async () => {
			expect(await verdict(command)).toBe("ran");
			expect(cards).toEqual([]);
		});
	}
});

describe("round 3: implicit literal joins and one-character separators", () => {
	for (const command of [
		`python3 -c "print(open('..' '/outside/secret.txt').read())"`,
		`python3 -c "print(open('..''/outside/secret.txt').read())"`,
	]) {
		test(`refused: ${command}`, async () => {
			expect(await verdict(command)).toBe("refused");
			expect(cards.length).toBeGreaterThan(0);
		});
	}
	for (const command of [
		"cut -d/ -f2 inside.txt",
		"sort -t/ -k2 inside.txt",
		"tr -d/ < inside.txt",
		"awk -F/ '{print $2}' inside.txt",
		"awk -F'/' '{print $2}' inside.txt",
	]) {
		test(`runs: ${command}`, async () => {
			expect(await verdict(command)).toBe("ran");
			expect(cards).toEqual([]);
		});
	}
});

describe("CI round: the refusal's label, and printing the home folder", () => {
	test("system headers are an allowance, so `cc -I/usr/include` runs where they exist (Linux)", () => {
		for (const dir of ["/usr/include", "/usr/local/include", "/opt/homebrew/include"])
			expect(DEFAULT_READ_ALLOWANCES).toContain(dir);
	});
	test("a boundary refusal is a rule, never the allowlist", async () => {
		const r = await systemOneGate("cat ../x", env(), ws, undefined, undefined, { project: ws });
		expect(r.run).toBe(false);
		expect(r.guard?.backend).toBe("rule");
		expect(r.guard?.model).toBe("workspace-boundary");
	});
	for (const command of [
		"bash -c 'echo $HOME'",
		"echo $HOME",
		"echo ~",
		'echo "${HOME}"',
		'printf "%s\\n" $HOME',
	]) {
		test(`printing the home folder's name reads nothing: ${command}`, async () => {
			expect(await verdict(command)).toBe("ran");
			expect(cards).toEqual([]);
		});
	}
	for (const command of [
		"cat ~/*",
		"cat $HOME/*",
		"cat ~/.ssh/id_rsa",
		"cat $HOME/notes.txt",
		// the home folder as the base a relative read resolves against
		"cd ~ && cat notes.txt",
		"cd $HOME; cat .ssh/id_rsa",
		"pushd ~ >/dev/null; cat notes.txt",
		"tar -C ~ -c .ssh",
		"tar -C $HOME -c .ssh",
		"git -C ~ status",
		"find ~ -name id_rsa",
		"grep -r PRIVATE ~",
		"rg PRIVATE $HOME",
		"ls -la ~",
		"cp -r ~ .tmp/h",
		"echo ~ | xargs ls",
		"echo $HOME; cat ~/notes.txt",
		"echo $(cat ~/notes.txt)",
	]) {
		test(`a file in the home folder is still asked about: ${command}`, async () => {
			expect(await verdict(command)).toBe("refused");
			cardsFor(command);
		});
	}
});

// The kernel rule that refuses these (EIGHT_OS_READ_BOUNDARY=1, macOS, #4890) is proven live in
// os-read-boundary.test.ts, through run_command, on the macos-read-boundary workflow.
describe("known gaps of a lexical check (a kernel read rule is the answer)", () => {
	test("a path built at run time is not seen, and this test says so", async () => {
		for (const command of [
			`python3 -c "print(open('..'+'/x').read())"`,
			"cat $OLDPWD/x",
			'cat "$(echo .)./x"',
			// a sed -f script file inside the root that itself names ../x: its body is not read here
			"sed -f sedscript package.json",
		])
			expect({ command, v: await verdict(command) }).toEqual({ command, v: "ran" });
	});
});
