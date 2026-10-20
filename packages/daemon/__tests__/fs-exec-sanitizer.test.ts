/**
 * fs.exec runs the engine's shell chain (preSpawnRefusal, sanitizeShellCommand, blockedReason)
 * before any spawn, so the verb allowlist is never the only gate. Wipe strings are the canonical
 * ones from packages/permissions tests (#4514 families 1-5, #4485), assembled so no line here is one.
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { _setAuditDir } from "../routes/store/audit";
import { execRefusal, fsExec } from "../routes/store/fs";
import type { JsonRpcContext } from "../routes/store/jsonrpc";

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "fs-exec-san-"));
const WORKSPACE = fs.realpathSync(fs.mkdirSync(path.join(TMP, "ws"), { recursive: true }) ?? TMP);
const MARKER = path.join(TMP, "spawned.marker");
const ctx = { socketKey: {}, notify: () => {}, initiator: "test" } as unknown as JsonRpcContext;
let savedRoot: string | undefined;
let savedLegacy: string | undefined;

beforeAll(() => {
	fs.mkdirSync(path.join(TMP, "audit"), { recursive: true });
	fs.mkdirSync(path.join(TMP, "ws"), { recursive: true });
	_setAuditDir(path.join(TMP, "audit"));
	savedRoot = process.env.EIGHT_WORKSPACE_ROOT;
	savedLegacy = process.env.EIGHT_LEGACY_BASH;
	process.env.EIGHT_WORKSPACE_ROOT = path.join(TMP, "ws");
	delete process.env.EIGHT_LEGACY_BASH;
});
afterAll(() => {
	if (savedRoot === undefined) delete process.env.EIGHT_WORKSPACE_ROOT;
	else process.env.EIGHT_WORKSPACE_ROOT = savedRoot;
	if (savedLegacy !== undefined) process.env.EIGHT_LEGACY_BASH = savedLegacy;
	fs.rmSync(TMP, { recursive: true, force: true });
});

const run = (command: string) =>
	fsExec({ command, conversationId: "c", workspaceId: "default" }, ctx) as Promise<{
		stdout: string;
		exitCode: number;
	}>;

async function refused(command: string): Promise<string> {
	type Blocked = { data?: { blocked?: boolean; reason?: string } };
	let caught: Blocked | undefined;
	try {
		await run(command);
	} catch (e) {
		caught = e as Blocked;
	}
	expect(caught).toBeDefined();
	expect((caught as Blocked).data?.blocked).toBe(true);
	return (caught as Blocked).data?.reason ?? "";
}

const RMW = ["r", "m"].join("");
const RMRF = ["rm", "-rf"].join(" ");
const DELW = ["-de", "lete"].join("");

// One or two canonical strings from each wipe-guard family, copied from the permissions tests.
const WIPES: Record<string, string[]> = {
	"home wipe (#4485)": [`${RMRF} ~`, `${RMRF} $HOME`, `true && ${RMRF} $HOME`],
	"family 1: ANSI-C escapes": [`${RMRF} $'\\x2f'`, `$'\\x72m' -rf /`, `$'rm' -rf /`],
	"family 2: brace and IFS": [`{,${RMW}} -rf /`, `r{m,x} -rf /`, `${RMW} -rf /{,}`],
	"family 3: bracket globs": [`${RMW} -rf [/]`, `${RMW} -rf /[/]`, `${RMW} -rf [[:punct:]]`],
	"family 4: delegated wipes": [
		`echo / | xargs ${RMW} -rf`,
		`find / ${DELW}`,
		`find ~ ${DELW}`,
		`xargs ${RMW} -rf <<< /`,
	],
	"family 5: variables and arrays": [
		`r=${RMW}; $r -rf /`,
		`d=/; ${RMW} -rf $d`,
		`x=${RMW}; eval $x -rf /`,
	],
};

describe("fs.exec refuses before spawn with the engine's words", () => {
	test("an unquoted heredoc redirect is refused with the sanitizer text and nothing is spawned", async () => {
		const reason = await refused(`cat > ${MARKER} << EOF\nx\nEOF`);
		expect(reason).toContain("[BLOCKED]");
		expect(reason).toContain("write_file");
		expect(fs.existsSync(MARKER)).toBe(false);
	});

	test("a quoted-file heredoc is refused too, and nothing is spawned", async () => {
		fs.mkdirSync(path.join(WORKSPACE, ".tmp"), { recursive: true });
		const reason = await refused("cat > .tmp/x.txt <<'EOF'\nx\nEOF");
		expect(reason).toContain("PERMISSION DENIED");
		expect(fs.existsSync(path.join(WORKSPACE, ".tmp", "x.txt"))).toBe(false);
	});

	test("find with its delete flag over the project is refused and the file survives", async () => {
		const victim = path.join(WORKSPACE, "victim.txt");
		fs.writeFileSync(victim, "keep");
		const reason = await refused(`find . -name victim.txt ${DELW}`);
		expect(reason).toContain("PERMISSION DENIED");
		expect(fs.existsSync(victim)).toBe(true);
	});

	test("find that runs a command is refused", async () => {
		await refused(`find . -exec touch ${MARKER} {} +`);
		expect(fs.existsSync(MARKER)).toBe(false);
	});

	test("the chain also holds under EIGHT_LEGACY_BASH=1", async () => {
		process.env.EIGHT_LEGACY_BASH = "1";
		try {
			await refused(`find . ${DELW}`);
		} finally {
			delete process.env.EIGHT_LEGACY_BASH;
		}
	});

	test("find -print0 piped to xargs -0 delete is refused and the file survives, also under EIGHT_LEGACY_BASH=1", async () => {
		const victim = path.join(WORKSPACE, "piped.txt");
		for (const legacy of [false, true]) {
			fs.writeFileSync(victim, "keep");
			if (legacy) process.env.EIGHT_LEGACY_BASH = "1";
			try {
				for (const line of [
					`find . -name piped.txt -print0 | xargs -0 ${RMW}`,
					`echo piped.txt | xargs ${RMW} -f`,
					`ls | parallel ${RMW}`,
					`echo piped.txt | sh -c "xargs ${RMW}"`,
				]) {
					await refused(line);
					expect(fs.existsSync(victim)).toBe(true);
				}
			} finally {
				delete process.env.EIGHT_LEGACY_BASH;
			}
		}
	});

	for (const [family, lines] of Object.entries(WIPES)) {
		test(`${family}: every canonical string is refused with the engine text`, async () => {
			for (const line of lines) {
				expect([line, execRefusal(line, WORKSPACE) !== null]).toEqual([line, true]);
				const reason = await refused(line);
				expect([line, /\[(BLOCKED|PERMISSION DENIED)\]/.test(reason)]).toEqual([line, true]);
			}
		});
	}
});

// Second read: what must not reach spawn on a route with no approval card, each also under EIGHT_LEGACY_BASH=1.
const CONFINED: Record<string, string[]> = {
	"git option that names a program to run": [
		"git -c diff.external='touch zz' diff --ext-diff",
		"git -c core.pager=x log",
		"git diff --output=out.txt",
		"git --exec-path=. status",
	],
	"search option that runs a preprocessor": [
		"rg --pre=./x.sh y",
		"rg --pre ./x.sh y",
		"grep -r key -f /etc/passwd .",
	],
	"interpreter or package runner": [
		`node -e "require('child_process').execSync('id')"`,
		"bun -e 'console.log(1)'",
		"npm exec -- curl x",
		"npx curl x",
		"python3 -c 'print(1)'",
		"sh -c 'echo hi'",
	],
	"write outside the workspace through a redirect": [
		"echo x > ../../out",
		"echo hi > ~/.zshrc",
		"echo hi >> /tmp/outside-ws",
		"echo x 1> ../out",
	],
	"write to a git-internal or secret path through a redirect": [
		"echo x > .git/config",
		"echo x > .env",
	],
	"read outside the workspace": [
		"cat ~/.aws/credentials",
		"grep -r key ~/.ssh",
		"cat ../../etc/hosts",
		"cat $HOME/.zshrc",
		"cat < ~/.zshrc",
	],
	"environment assignment before a command": ["FOO=1 curl x", "FOO=1 echo hi"],
	"glob that expands to the parent directory": ["cat .?/secret", "ls .?/.?/", "ls [.][.]", "ls .*"],
	"git that changes state": [
		"git branch -D main",
		"git branch -d x",
		"git branch -m a b",
		"git branch newbranch",
		"git tag -d v1",
		"git checkout main",
		"git switch main",
		"git reset HEAD",
		"git clean -n",
		"git push",
		"git commit -m x",
		"git merge x",
		"git rebase x",
		"git stash",
		"git remote -v",
		"git config user.name x",
	],
	"command off the allowlist": ["curl x", "echo x | tee out.txt", "ncat -e /bin/sh x 1"],
};

describe("fs.exec is confined to the workspace (no approval card on this route)", () => {
	for (const [name, lines] of Object.entries(CONFINED)) {
		test(`${name}: refused before spawn, with and without EIGHT_LEGACY_BASH=1`, async () => {
			for (const legacy of [false, true]) {
				if (legacy) process.env.EIGHT_LEGACY_BASH = "1";
				try {
					for (const line of lines) {
						await refused(line);
					}
				} finally {
					delete process.env.EIGHT_LEGACY_BASH;
				}
			}
		});
	}

	test("a redirect to a file inside the workspace still runs", async () => {
		const r = await run("echo kept > inside.txt");
		expect(r.exitCode).toBe(0);
		expect(fs.readFileSync(path.join(WORKSPACE, "inside.txt"), "utf-8").trim()).toBe("kept");
	});
});

describe("fs.exec refuses globs outright", () => {
	test("a glob that would match a link pointing out of the root is refused before spawn", async () => {
		const outside = path.join(TMP, "glob-outside");
		fs.mkdirSync(outside, { recursive: true });
		fs.writeFileSync(path.join(outside, "passwd"), "secret");
		fs.symlinkSync(outside, path.join(WORKSPACE, "link"));
		for (const line of [
			"cat li*/passwd",
			"cat */passwd",
			"cat l?nk/passwd",
			"cat l[i]nk/passwd",
			'find . -name "*.ts"',
			"echo x > li*",
		]) {
			const reason = await refused(line);
			expect([
				line,
				reason.includes("Globs are not allowed on this route, name the files"),
			]).toEqual([line, true]);
		}
	});

	test("brace expansion that names a link or the parent is refused", async () => {
		for (const line of [
			"cat {link,x}/passwd",
			"cat {..,x}/secret",
			"ls {..,.}",
			"echo x > {..,x}/out",
		]) {
			await refused(line);
		}
	});

	test("ls with no glob still runs", async () => {
		expect((await run("ls")).exitCode).toBe(0);
	});
});

describe("fs.exec parent-glob refusal text", () => {
	test("says the operand looks like a glob that could reach the parent, not that a path leaves the workspace", () => {
		for (const line of ['grep "[Ee]rr" f', 'find . -name ".?x"', "cat .?/secret"]) {
			const r = execRefusal(line, WORKSPACE) ?? "";
			expect(r).toContain("looks like a glob that could reach the parent directory");
			expect(r).toContain("Rephrase it or quote it differently");
			expect(r).not.toContain("outside the workspace");
		}
	});
});

describe("fs.exec follows symlinks when it confines", () => {
	test("a link inside the root that points outside is refused; one that points inside still runs", async () => {
		const outside = path.join(TMP, "outside-dir");
		fs.mkdirSync(outside, { recursive: true });
		fs.writeFileSync(path.join(outside, "x"), "secret");
		fs.symlinkSync(outside, path.join(WORKSPACE, "link-out"));
		fs.mkdirSync(path.join(WORKSPACE, "real"), { recursive: true });
		fs.writeFileSync(path.join(WORKSPACE, "real", "y"), "fine");
		fs.symlinkSync(path.join(WORKSPACE, "real"), path.join(WORKSPACE, "link-in"));
		for (const line of [
			"cat link-out/x",
			"cat link-out/missing",
			"cat link-out/../outside-dir/x",
			"echo x > link-out/new.txt",
			"grep -r secret link-out",
		]) {
			await refused(line);
		}
		expect(fs.existsSync(path.join(outside, "new.txt"))).toBe(false);
		expect((await run("cat link-in/y")).stdout).toBe("fine");
	});
});

describe("fs.exec still runs plain allowed commands", () => {
	test("cat and grep of a file inside the root, and an absolute path inside the root", async () => {
		fs.writeFileSync(path.join(WORKSPACE, "in.txt"), "alpha\nbeta\n");
		expect((await run("cat in.txt")).stdout).toContain("alpha");
		expect((await run("grep -r beta .")).stdout).toContain("beta");
		expect((await run(`cat ${path.join(WORKSPACE, "in.txt")}`)).stdout).toContain("beta");
		expect((await run("git status")).exitCode).toBeDefined();
		expect((await run("git branch")).exitCode).toBeDefined();
		expect(execRefusal("git branch --list", WORKSPACE)).toBeNull();
		expect(execRefusal("git branch -a", WORKSPACE)).toBeNull();
		expect(execRefusal("git log --oneline", WORKSPACE)).toBeNull();
	});

	test("xargs with a harmless verb runs, also under EIGHT_LEGACY_BASH=1", async () => {
		fs.writeFileSync(path.join(WORKSPACE, "w.txt"), "one\ntwo\n");
		for (const legacy of [false, true]) {
			if (legacy) process.env.EIGHT_LEGACY_BASH = "1";
			try {
				const r = await run("echo w.txt | xargs wc -l");
				expect(r.exitCode).toBe(0);
				expect(r.stdout).toContain("2");
			} finally {
				delete process.env.EIGHT_LEGACY_BASH;
			}
		}
	});

	test("echo runs and returns its output", async () => {
		const r = await run("echo hello-fs-exec");
		expect(r.exitCode).toBe(0);
		expect(r.stdout.trim()).toBe("hello-fs-exec");
	});

	test("a read-only pipeline and a plain find run", async () => {
		fs.writeFileSync(path.join(WORKSPACE, "a.txt"), "one\ntwo\n");
		expect((await run("cat a.txt | wc -l")).stdout.trim()).toBe("2");
		expect((await run("find . -name a.txt")).stdout).toContain("a.txt");
	});
});
