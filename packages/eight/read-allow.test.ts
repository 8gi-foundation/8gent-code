/**
 * #4715: a file the person names in the ask can be read; a path that cannot be read says so
 * once and then stops the turn; chains of read-only commands run; the run cannot spawn itself.
 * Real ToolExecutor and native tools, System One with no judge (rules and allowlist only).
 */

import { afterAll, afterEach, beforeEach, test as bunTest, describe, expect } from "bun:test";
import {
	existsSync,
	mkdirSync,
	mkdtempSync,
	realpathSync,
	rmSync,
	symlinkSync,
	unlinkSync,
	writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { test } from "../../tests/scoped-test";
import { cleanupTempDirs, tempDir } from "../../tests/temp-dirs";
import { agentTools, setToolContext } from "../ai/tools";
import { spawnsSelf } from "../permissions/pre-spawn-backstops";
import {
	CANNOT_READ_TEXT,
	ReadScope,
	addReadAllowDir,
	allowReadsFromPrompt,
	approvedGrants,
	extractPromptPaths,
	isApprovedRead,
	isReadAllowed,
	namesSecret,
	readAllowEntries,
	rememberApprovedReads,
	resetReadAllow,
	runAllowReadCommand,
	runInReadScope,
	takeBoundaryStop,
} from "../permissions/read-allow";
import { readBoundaryGate } from "../permissions/read-boundary";
import { CreatedFiles } from "../permissions/s1-created-files";
import { _resetSystemOne, _setSystemOneOverridesForTests } from "../permissions/system-one-gate";
import { readPrefixesFor, splitChain } from "./read-chain";
import { parseRunArgs } from "./run";
import { ToolExecutor } from "./tools";

afterAll(() => {
	_resetSystemOne();
	cleanupTempDirs();
});

type PM = {
	checkPermission: (command: string) => "allowed" | "denied" | "ask";
};

let cwd = "";
let outside = "";
let secretDir = "";
let executor: ToolExecutor;
let pm: PM;
let origCheck: PM["checkPermission"];
const savedRoot = process.env.EIGHT_WORKSPACE_ROOT;

beforeEach(() => {
	resetReadAllow();
	takeBoundaryStop();
	cwd = realpathSync(tempDir("read-allow-cwd-"));
	outside = realpathSync(tempDir("read-allow-out-"));
	secretDir = join(outside, "secrets");
	mkdirSync(secretDir, { recursive: true });
	writeFileSync(join(outside, "inbox.jsonl"), "one\ntwo\nthree\n");
	writeFileSync(join(outside, "other.txt"), "other\n");
	writeFileSync(join(secretDir, "token.txt"), "hunter2\n");
	process.env.EIGHT_WORKSPACE_ROOT = cwd;
	_setSystemOneOverridesForTests({
		createDecider: () => {
			throw new Error("no judge in this test");
		},
		askHuman: async () => null,
		calibrationDir: tempDir("read-allow-nocal-"),
	});
	executor = new ToolExecutor(cwd, "read-allow");
	pm = (executor as unknown as { permissionManager: PM }).permissionManager;
	origCheck = pm.checkPermission;
	pm.checkPermission = () => "allowed";
});

afterEach(() => {
	pm.checkPermission = origCheck;
	resetReadAllow();
	if (savedRoot === undefined) Reflect.deleteProperty(process.env, "EIGHT_WORKSPACE_ROOT");
	else process.env.EIGHT_WORKSPACE_ROOT = savedRoot;
});

const run = (command: string) => executor.execute("run_command", { command });
const read = (path: string) => executor.execute("read_file", { path });

describe("point 1: paths in the ask are readable", () => {
	test("extracts absolute and ~/ paths, trims punctuation, ignores urls and bare ~", () => {
		const got = extractPromptPaths(
			'Read /tmp/a/b.txt, then "~/x/y.md" and (/var/log/z.log). See https://e.com/p/q and ~ alone.',
			"/home/u",
		);
		expect(got).toEqual(["/tmp/a/b.txt", "/home/u/x/y.md", "/var/log/z.log"]);
	});

	test("without the ask, read_file outside the working directory is blocked", async () => {
		expect(await read(join(outside, "inbox.jsonl"))).toContain(CANNOT_READ_TEXT);
	});

	test("a path named in the ask allows its folder for read_file, list_files and read-only commands", async () => {
		allowReadsFromPrompt(`Read ${join(outside, "inbox.jsonl")} and print the last line`, cwd);
		expect(readAllowEntries()).toEqual([outside]);
		expect(await read(join(outside, "inbox.jsonl"))).toContain("three");
		expect(await executor.execute("list_files", { path: outside })).toContain("other.txt");
		expect(await run(`tail -n 1 ${join(outside, "inbox.jsonl")}`)).toContain("three");
		expect(await run(`cat ${join(outside, "inbox.jsonl")} | wc -l`)).toContain("3");
	});

	test("writes stay inside cwd: write_file, edit_file and a redirect outside are refused", async () => {
		allowReadsFromPrompt(`Read ${join(outside, "inbox.jsonl")}`, cwd);
		const w = await executor.execute("write_file", {
			path: join(outside, "new.txt"),
			content: "x",
		});
		expect(w).toContain("was NOT written");
		await run(`echo hi > ${join(outside, "new.txt")}`);
		expect(existsSync(join(outside, "new.txt"))).toBe(false);
		await run(`rm ${join(outside, "other.txt")}`);
		expect(existsSync(join(outside, "other.txt"))).toBe(true);
		await run(`cp ${join(outside, "other.txt")} ${join(outside, "copy.txt")}`);
		expect(existsSync(join(outside, "copy.txt"))).toBe(false);
	});

	test("a folder the ask did not name stays blocked", async () => {
		const elsewhere = realpathSync(tempDir("read-allow-else-"));
		writeFileSync(join(elsewhere, "f.txt"), "f");
		allowReadsFromPrompt(`Read ${join(outside, "inbox.jsonl")}`, cwd);
		expect(await read(join(elsewhere, "f.txt"))).toContain(CANNOT_READ_TEXT);
	});

	test("secrets stay blocked: a secrets/ path named in the ask is not allowed", async () => {
		allowReadsFromPrompt(`Read ${join(secretDir, "token.txt")}`, cwd);
		expect(readAllowEntries()).toEqual([]);
		expect(await read(join(secretDir, "token.txt"))).toContain("cannot be read");
		allowReadsFromPrompt(`Read ${join(outside, "inbox.jsonl")}`, cwd);
		expect(await read(join(secretDir, "token.txt"))).not.toContain("hunter2");
		expect(await run(`cat ${join(secretDir, "token.txt")}`)).not.toContain("hunter2");
	});

	test("a file directly in home allows only that file, never home", () => {
		allowReadsFromPrompt("Read ~/notes.txt", cwd, "/home/u");
		expect(readAllowEntries()).toEqual(["/home/u/notes.txt"]);
		resetReadAllow();
		expect(addReadAllowDir("~", cwd, "/home/u")).toBeNull();
		expect(addReadAllowDir("/", cwd, "/home/u")).toBeNull();
		expect(addReadAllowDir("/home", cwd, "/home/u")).toBeNull();
	});

	test("a symlink inside an allowed folder cannot lead outside it", async () => {
		const other = realpathSync(tempDir("read-allow-link-"));
		writeFileSync(join(other, "hidden.txt"), "LINKBODY\n");
		symlinkSync(other, join(outside, "link"));
		allowReadsFromPrompt(`Read ${join(outside, "inbox.jsonl")}`, cwd);
		expect(await read(join(outside, "link", "hidden.txt"))).not.toContain("LINKBODY");
	});

	test("a folder named through a symlink (as /tmp is /private/tmp) is readable by commands too", async () => {
		const via = join(cwd, "..", `via-${process.pid}`);
		symlinkSync(outside, via);
		try {
			allowReadsFromPrompt(`Read ${join(via, "inbox.jsonl")}`, cwd);
			expect(await run(`tail -n 1 ${join(via, "inbox.jsonl")}`)).toContain("three");
			expect(await read(join(via, "inbox.jsonl"))).toContain("three");
		} finally {
			unlinkSync(via);
		}
	});

	test("--allow-read is parsed, repeatable, and its value is not part of the prompt", () => {
		const o = parseRunArgs(["--allow-read", "/a/b", "--allow-read=/c", "do", "it"]);
		expect(o.allowRead).toEqual(["/a/b", "/c"]);
		expect(o.prompt).toBe("do it");
		expect(parseRunArgs(["x"]).allowRead).toBeUndefined();
	});

	test("addReadAllowDir (the flag) lets a run read a folder the ask did not name", async () => {
		expect(addReadAllowDir(outside, cwd)).toBe(outside);
		expect(await read(join(outside, "other.txt"))).toContain("other");
	});

	test("/allow-read adds a folder and says so; a too-wide one is refused", () => {
		expect(runAllowReadCommand([outside], cwd)).toContain(`allowed under ${outside}`);
		expect(readAllowEntries()).toEqual([outside]);
		expect(runAllowReadCommand(["/"], cwd)).toContain("Not allowed");
		expect(runAllowReadCommand([], cwd)).toContain("Usage: /allow-read <dir>");
	});

	test("the native read_file honours the same list", async () => {
		setToolContext({ workingDirectory: cwd, createdFiles: new CreatedFiles() });
		const nativeRead = (p: string) =>
			(
				agentTools.read_file as unknown as { execute: (i: unknown, o: unknown) => Promise<string> }
			).execute({ path: p }, {});
		expect(await nativeRead(join(outside, "inbox.jsonl"))).toContain(CANNOT_READ_TEXT);
		allowReadsFromPrompt(`Read ${join(outside, "inbox.jsonl")}`, cwd);
		expect(await nativeRead(join(outside, "inbox.jsonl"))).toContain("three");
	});
});

describe("points 2 and 3: a boundary block is terminal, and names no blocked class", () => {
	test("the first block tells the model to tell the person and stop", async () => {
		const out = await read(join(outside, "inbox.jsonl"));
		expect(out).toStartWith(`Error: ${CANNOT_READ_TEXT}`);
		expect(out).toContain("--allow-read");
		expect(takeBoundaryStop()).toBeNull();
	});

	test("a second block on the same path ends the turn with a reply naming the path and the flag", async () => {
		const file = join(outside, "inbox.jsonl");
		await read(file);
		expect(takeBoundaryStop()).toBeNull();
		await run(`cat ${file}`);
		const stop = takeBoundaryStop();
		expect(stop).toContain(file);
		expect(stop).toContain(`--allow-read ${outside}`);
		expect(takeBoundaryStop()).toBeNull(); // taken once
	});

	test("a different path starts its own count", async () => {
		await read(join(outside, "inbox.jsonl"));
		await read(join(outside, "other.txt"));
		expect(takeBoundaryStop()).toBeNull();
	});

	test("a boundary-blocked command never suggests cat/ls or approval", async () => {
		const out = await run(`cat ${join(outside, "inbox.jsonl")}`);
		expect(out).toContain(CANNOT_READ_TEXT);
		expect(out).not.toMatch(/request approval|Try a read-only command/i);
	});

	test("a non-boundary command block never says request approval either", async () => {
		const out = await executor.execute("delete_file", { path: join(cwd, "nope.txt") });
		expect(out).not.toMatch(/request approval/i);
	});

	test("a blocked write keeps its own message", async () => {
		const out = await executor.execute("write_file", {
			path: join(outside, "n.txt"),
			content: "x",
		});
		expect(out).toContain("was NOT written");
		expect(out).not.toContain(CANNOT_READ_TEXT);
	});

	test("the native read_file block is terminal too", async () => {
		setToolContext({ workingDirectory: cwd, createdFiles: new CreatedFiles() });
		const nativeRead = (p: string) =>
			(
				agentTools.read_file as unknown as { execute: (i: unknown, o: unknown) => Promise<string> }
			).execute({ path: p }, {});
		const file = join(outside, "inbox.jsonl");
		expect(await nativeRead(file)).toStartWith(`Error: ${CANNOT_READ_TEXT}`);
		await nativeRead(file);
		expect(takeBoundaryStop()).toContain(file);
	});
});

describe("point 4: a run cannot spawn itself", () => {
	test.each([
		"8gent chat hello",
		"8gent run 'do it'",
		"8gent mcp-server --tools=safe < in.jsonl",
		"bun bin/8gent.ts chat hi",
		"bun run packages/../bin/8gent.ts run x",
		"cd /tmp && 8gent chat hi",
		"FOO=1 8gent run x",
		"echo hi; 8gent mcp-server",
		"./node_modules/.bin/8gent chat x",
		"node dist/cli.js chat hi",
		"node /x/cli.js run do-it",
		"npx @8gi-foundation/8gent-code run hi",
		"npx -y @8gi-foundation/8gent-code mcp-server",
		"bun dist/cli.js mcp-server",
	])("refuses %s", async (cmd) => {
		expect(spawnsSelf(cmd)).toBe(true);
	});

	test.each(["node server.js run"])("allows %s", (cmd) => {
		expect(spawnsSelf(cmd)).toBe(false);
	});

	test("run_command refuses with the already-8gent line, before any spawn", async () => {
		const out = await run("8gent chat 'Read the group inbox'");
		expect(out).toContain("You are already 8gent; use your tools");
		expect(await run("bun bin/8gent.ts mcp-server")).toContain("already 8gent");
	});

	test("the native run_command refuses it too", async () => {
		setToolContext({ workingDirectory: cwd, createdFiles: new CreatedFiles() });
		const out = await (
			agentTools.run_command as unknown as { execute: (i: unknown, o: unknown) => Promise<string> }
		).execute({ command: "8gent run hi" }, {});
		expect(out).toContain("already 8gent");
	});
});

describe("point 5: read-only chaining", () => {
	test("splitChain splits on unquoted ; and && only", () => {
		expect(splitChain("ls a; echo ---; wc -l f")).toEqual(["ls a", "echo ---", "wc -l f"]);
		expect(splitChain("cd x && ls")).toEqual(["cd x", "ls"]);
		expect(splitChain("echo 'a;b && c'")).toEqual(["echo 'a;b && c'"]);
	});

	test("`;` between read-only commands runs", async () => {
		const out = await run("ls; echo ---; wc -l other.txt");
		expect(out).not.toContain("BLOCKED");
		expect(out).toContain("---");
	});

	test("`&&` between read-only commands runs", async () => {
		writeFileSync(join(cwd, "a.txt"), "a\nb\n");
		const out = await run("ls && wc -l a.txt");
		expect(out).not.toContain("BLOCKED");
		expect(out).toContain("a.txt");
	});

	test("a chain with one write part is still refused with the chaining reason", async () => {
		const out = await run("ls; touch made.txt");
		expect(out).toContain("Semicolon command chaining is not allowed");
		expect(await run("ls && rm a.txt")).toContain("Command chaining with && is not allowed");
	});

	test("`||`, `&` and a substitution part still refuse", async () => {
		expect(await run("ls || ls")).toContain("is not allowed");
		expect(await run("ls & ls")).toContain("is not allowed");
		expect(await run("ls; echo $(id)")).toContain("is not allowed");
	});

	test("each part meets System One: a read-only chain naming a secret is blocked", async () => {
		writeFileSync(join(cwd, ".env"), "K=v\n");
		const out = await run("ls; cat .env");
		expect(out).toMatch(/BLOCKED|DENIED/);
		expect(out).not.toContain("K=v");
	});

	test("a chained read of a path outside the folder is still a boundary block", async () => {
		const out = await run(`ls; cat ${join(outside, "inbox.jsonl")}`);
		expect(out).not.toContain("three");
	});

	test("with the path named, a chained read of it runs", async () => {
		allowReadsFromPrompt(`Read ${join(outside, "inbox.jsonl")}`, cwd);
		const out = await run(`ls ${outside}; wc -l ${join(outside, "inbox.jsonl")}`);
		expect(out).toContain("inbox.jsonl");
		expect(out).toContain("3");
	});

	test("the native run_command chains read-only parts too", async () => {
		setToolContext({ workingDirectory: cwd, createdFiles: new CreatedFiles() });
		const out = await (
			agentTools.run_command as unknown as { execute: (i: unknown, o: unknown) => Promise<string> }
		).execute({ command: "ls; echo ---" }, {});
		expect(out).toContain("---");
		expect(out).not.toContain("BLOCKED");
	});
});

describe("8SO read on #4722: siblings, depth floor, real paths, session scope", () => {
	const HOME = "/home/u";
	const entriesFor = (ask: string) => {
		resetReadAllow();
		allowReadsFromPrompt(ask, cwd, HOME);
		return readAllowEntries();
	};

	test.each([
		["~/.8gent/foo.json", ["/home/u/.8gent/telegram.env", "/home/u/.8gent/sessions/x.json"]],
		[
			"~/Library/foo",
			[
				"/home/u/Library/Application Support/Google/Chrome/Default/Cookies",
				"/home/u/Library/Keychains/login.keychain-db",
				"/home/u/Library/Cookies/Cookies.binarycookies",
				"/home/u/Library/Messages/chat.db",
			],
		],
		["~/.config/gh/hosts.yml", ["/home/u/.config/gh/hosts.yml"]],
		["~/.docker/config.json", ["/home/u/.docker/config.json"]],
		["~/.git-credentials", ["/home/u/.git-credentials"]],
		["/etc/hosts", ["/etc/master.passwd", "/etc/ssh/ssh_host_ed25519_key", "/etc/passwd"]],
	])("a named file %s never exposes its siblings", (ask, probes) => {
		const got = entriesFor(`Read ${ask}`);
		for (const probe of probes) expect([probe, isReadAllowed(probe)]).toEqual([probe, false]);
		// at most the exact file, never a folder
		for (const e of got) expect(e).not.toMatch(/\/$/);
	});

	test.each([
		".netrc",
		".npmrc",
		".git-credentials",
		".config/gh/hosts.yml",
		".docker/config.json",
		".kube/config",
		".8gent/telegram.env",
		".8gent/bot.env",
		".8gent/api-token.txt",
		"Library/Keychains/login.keychain-db",
		"Library/Application Support/Google/Chrome/Default/Cookies",
		"Library/Application Support/Firefox/Profiles/a.default/cookies.sqlite",
		"Library/Application Support/Microsoft Edge/Default/History",
		"Library/Application Support/BraveSoftware/x",
		"Library/Application Support/Chromium/x",
		"Library/Cookies/Cookies.binarycookies",
		"Library/Messages/chat.db",
		"Library/Mail/V10/x",
		"Library/Safari/History.db",
		"etc/master.passwd",
		"etc/ssh/ssh_host_rsa_key",
		"keys/server.pem",
		"keys/server.key",
		"keys/bundle.p12",
		"x/.env.local",
		"x/prod.env",
	])("%s is a secret path inside a named folder", (rel) => {
		const dir = join(HOME, "data", "stuff");
		resetReadAllow();
		allowReadsFromPrompt(`Read ${join(dir, "a.txt")}`, cwd, HOME);
		expect(isReadAllowed(join(dir, "a.txt"))).toBe(true);
		expect(namesSecret(`/${rel}`)).toBe(true);
		expect([rel, isReadAllowed(join(dir, rel))]).toEqual([rel, false]);
	});

	test("the real path is checked too: a harmless-looking link to a secret is refused", () => {
		symlinkSync(join(secretDir, "token.txt"), join(outside, "benign.txt"));
		addReadAllowDir(outside, cwd);
		expect(isReadAllowed(join(outside, "other.txt"))).toBe(true);
		expect(isReadAllowed(join(outside, "benign.txt"))).toBe(false);
	});

	test("depth floor: a folder under home needs 2 segments, so ~/.8gent and ~/Library fall back to the file", () => {
		expect(entriesFor("Read ~/.8gent/foo.json")).toEqual(["/home/u/.8gent/foo.json"]);
		expect(entriesFor("Read ~/Library/foo")).toEqual(["/home/u/Library/foo"]);
		expect(entriesFor("Read ~/Documents/a.txt")).toEqual(["/home/u/Documents/a.txt"]);
		expect(entriesFor("Read ~/.8gent/inbox/group-inbox.jsonl")).toEqual(["/home/u/.8gent/inbox"]);
		expect(entriesFor("Read ~/work/proj/a.txt")).toEqual(["/home/u/work/proj"]);
	});

	test.each([
		"/etc",
		"/etc/ssh",
		"/var",
		"/var/log",
		"/private",
		"/private/etc",
		"/Library",
		"/System",
		"/usr",
		"/usr/lib",
		"/Users",
		"/Users/other",
		"/Users/other/Documents",
		"/",
	])("%s is never handed over as a directory", (dir) => {
		resetReadAllow();
		expect(addReadAllowDir(dir, cwd, HOME)).toBeNull();
	});

	test.each([
		["/etc/hosts", "/etc/hosts"],
		["/var/log/system.log", "/var/log/system.log"],
		["/Users/other/notes.txt", "/Users/other/notes.txt"],
		["/Users/other/Documents/notes.txt", "/Users/other/Documents/notes.txt"],
		["/usr/lib/x.txt", "/usr/lib/x.txt"],
	])("a file in a broad system folder, %s, allows only itself", (file, entry) => {
		expect(entriesFor(`Read ${file}`)).toEqual([entry]);
	});

	test("a deep folder outside home and the system roots is still allowed", () => {
		expect(entriesFor("Read /srv/data/in/a.txt")).toEqual(["/srv/data/in"]);
		expect(entriesFor("Read /Users/other/work/proj/a.txt")).toEqual(["/Users/other/work/proj"]);
	});

	test("each session has its own allowlist; another session never sees it", () => {
		const a = new ReadScope();
		const b = new ReadScope();
		runInReadScope(a, () => allowReadsFromPrompt(`Read ${join(outside, "inbox.jsonl")}`, cwd));
		expect(runInReadScope(a, () => isReadAllowed(join(outside, "other.txt")))).toBe(true);
		expect(runInReadScope(b, () => isReadAllowed(join(outside, "other.txt")))).toBe(false);
	});

	test("prompt entries are rebuilt each turn from that turn's message; manual entries stay for the session", () => {
		const s = new ReadScope();
		const other = realpathSync(tempDir("read-allow-turn2-"));
		writeFileSync(join(other, "n.txt"), "n");
		runInReadScope(s, () => {
			addReadAllowDir(outside, cwd);
			allowReadsFromPrompt(`Read ${join(other, "n.txt")}`, cwd);
			expect(isReadAllowed(join(other, "n.txt"))).toBe(true);
			// next turn names nothing: the first turn's prompt entry is gone
			allowReadsFromPrompt("Just say hello", cwd);
			expect(isReadAllowed(join(other, "n.txt"))).toBe(false);
			expect(isReadAllowed(join(outside, "other.txt"))).toBe(true);
		});
	});

	test("block counts and the stop live in the session scope", async () => {
		const s = new ReadScope();
		await runInReadScope(s, async () => {
			await read(join(outside, "inbox.jsonl"));
			await read(join(outside, "inbox.jsonl"));
		});
		expect(takeBoundaryStop()).toBeNull(); // the fallback scope saw nothing
		expect(takeBoundaryStop(s)).toContain(join(outside, "inbox.jsonl"));
	});
});

describe("no session scope remembers nothing (#4901)", () => {
	const file = () => join(outside, "other.txt");

	bunTest("a yes made with no scope is not visible to a later call with no scope", () => {
		allowReadsFromPrompt(`Read ${file()}`, cwd);
		addReadAllowDir(outside, cwd);
		expect(isReadAllowed(file())).toBe(false);
		expect(readAllowEntries()).toEqual([]);
	});

	bunTest("a no-scope call never sees approvals from a scoped session", () => {
		const s = new ReadScope();
		runInReadScope(s, () => {
			allowReadsFromPrompt(`Read ${file()}`, cwd);
			addReadAllowDir(outside, cwd);
		});
		expect(runInReadScope(s, () => isReadAllowed(file()))).toBe(true);
		expect(isReadAllowed(file())).toBe(false);
		expect(readAllowEntries()).toEqual([]);
	});

	bunTest("a no-scope yes does not leak into a scoped session", () => {
		allowReadsFromPrompt(`Read ${file()}`, cwd);
		expect(runInReadScope(new ReadScope(), () => isReadAllowed(file()))).toBe(false);
	});
});

describe("Solomon second read on #4722", () => {
	test.each([
		"cat DIR/.en?",
		"cat DIR/.e*",
		"head DIR/*",
		"grep -r SECRET DIR",
		"grep -R SECRET DIR",
		"grep --recursive SECRET DIR",
		"find DIR -name x",
		"rg SECRET DIR",
		"du DIR",
		"cat DIR/[.]env",
		"cat DIR/{.env,notes.md}",
	])("%s gets no read prefixes", (cmd) => {
		const dir = join(outside, "box");
		mkdirSync(dir, { recursive: true });
		writeFileSync(join(dir, "notes.md"), "n");
		writeFileSync(join(dir, ".env"), "SECRET=1");
		allowReadsFromPrompt(`Read ${join(dir, "notes.md")}`, cwd);
		expect(readPrefixesFor(cmd.replaceAll("DIR", dir))).toBeUndefined();
		expect(readPrefixesFor(`cat ${join(dir, "notes.md")}`)).toBeDefined();
	});

	test("a glob in the shell cannot read the .env beside the named file", async () => {
		const dir = join(outside, "box2");
		mkdirSync(dir, { recursive: true });
		writeFileSync(join(dir, "notes.md"), "n");
		writeFileSync(join(dir, ".env"), "GLOBSECRET=1");
		allowReadsFromPrompt(`Read ${join(dir, "notes.md")}`, cwd);
		for (const c of [
			`cat ${dir}/.en?`,
			`cat ${dir}/.e*`,
			`head ${dir}/*`,
			`grep -r GLOBSECRET ${dir}`,
		])
			expect(await run(c)).not.toContain("GLOBSECRET");
	});

	test.each([
		"8gent-run x",
		"8gent-run",
		"8gent --model x chat",
		"8gent --model x --yes run hi",
		"bash -c '8gent chat'",
		'sh -c "8gent run hi"',
		"zsh -c '8gent chat'",
		"env 8gent chat",
		"env -i FOO=1 8gent chat",
		"nohup 8gent chat",
		"exec 8gent run x",
		"time 8gent chat",
		"command 8gent chat",
		"sudo 8gent chat",
		"echo x | xargs 8gent run",
		"$(which 8gent) chat",
		"nohup env 8gent mcp-server",
	])("self-spawn refused: %s", (cmd) => {
		expect(spawnsSelf(cmd)).toBe(true);
	});

	test.each(["sudo ls", "env FOO=1 ls", "time ls"])("not a self-spawn: %s", (cmd) => {
		expect(spawnsSelf(cmd)).toBe(false);
	});

	test.each([
		"/private/var/db",
		"/private/var",
		"/var/db",
		"/tmp",
		"/private/tmp",
		"/tmp/x",
		"/Volumes",
		"/Volumes/disk",
		"/private/etc",
	])("%s is never handed over as a folder", (dir) => {
		resetReadAllow();
		expect(addReadAllowDir(dir, cwd, "/home/u")).toBeNull();
	});

	test("a file in /private/var/db or /tmp allows only itself", () => {
		for (const f of [
			"/private/var/db/x.plist",
			"/tmp/a.txt",
			"/private/tmp/a.txt",
			"/Volumes/disk/a.txt",
		]) {
			resetReadAllow();
			allowReadsFromPrompt(`Read ${f}`, cwd, "/home/u");
			expect(readAllowEntries()).toEqual([f]);
		}
	});

	test.each([
		".config/op/config",
		".config/gcloud/legacy_credentials/a/adc.json",
		".password-store/x.gpg",
		".pgpass",
		".vault-token",
		".azure/accessTokens.json",
		"Library/Application Support/1Password/x",
		"Library/Application Support/Arc/User Data/Default/Cookies",
		".config/github-copilot/hosts.json",
		".local/share/keyrings/login.keyring",
	])("%s is a secret path", (rel) => {
		expect(namesSecret(`/home/u/${rel}`)).toBe(true);
	});
});

describe("brace expansion (Karen, #4722)", () => {
	test("namesSecret sees a secret name after { or ,", () => {
		expect(namesSecret("/x/{.env,notes.md}")).toBe(true);
		expect(namesSecret("/x/{notes.md,.env}")).toBe(true);
		expect(namesSecret("/x/{a,b}")).toBe(false);
	});
});

describe("a link to a credential inside an approved folder (#4902)", () => {
	test("the folder is refused when it holds a link to a credential", () => {
		const outside = tempDir("ra-out-");
		const folder = tempDir("ra-dir-");
		writeFileSync(join(outside, "id_rsa"), "key");
		writeFileSync(join(folder, "note.md"), "hi");
		symlinkSync(join(outside, "id_rsa"), join(folder, "lnk"));
		const scope = new ReadScope();
		rememberApprovedReads([folder], [], scope);
		expect(approvedGrants([folder], [])).toEqual([]);
		expect(isApprovedRead(join(folder, "lnk"), scope)).toBe(false);
		expect(isApprovedRead(join(folder, "lnk", "anything"), scope)).toBe(false);
		expect(isApprovedRead(join(folder, "note.md"), scope)).toBe(false);
	});

	test("a plain folder is still approved, a plain file in it readable", () => {
		const folder = tempDir("ra-ok-");
		writeFileSync(join(folder, "note.md"), "hi");
		const scope = new ReadScope();
		rememberApprovedReads([folder], [], scope);
		expect(isApprovedRead(join(folder, "note.md"), scope)).toBe(true);
	});

	test("a folder approved clean turns unsafe when a link to a credential appears", () => {
		const outside = tempDir("ra-out2-");
		const folder = tempDir("ra-late-");
		writeFileSync(join(outside, "id_rsa"), "key");
		writeFileSync(join(folder, "note.md"), "hi");
		const scope = new ReadScope();
		rememberApprovedReads([folder], [], scope);
		expect(isApprovedRead(join(folder, "note.md"), scope)).toBe(true);
		symlinkSync(join(outside, "id_rsa"), join(folder, "lnk"));
		expect(isApprovedRead(join(folder, "lnk"), scope)).toBe(false);
		expect(isApprovedRead(join(folder, "note.md"), scope)).toBe(false);
	});

	test("a remembered single file that is a link to a credential is unsafe", () => {
		const outside = tempDir("ra-out3-");
		const folder = tempDir("ra-file-");
		writeFileSync(join(outside, "id_rsa"), "key");
		symlinkSync(join(outside, "id_rsa"), join(folder, "lnk"));
		const scope = new ReadScope();
		scope.approvedReads.add(join(folder, "lnk"));
		expect(isApprovedRead(join(folder, "lnk"), scope)).toBe(false);
	});

	test("a dangling link counts as unsafe", () => {
		const folder = tempDir("ra-dang-");
		symlinkSync(join(folder, "missing"), join(folder, "lnk"));
		expect(approvedGrants([folder], [])).toEqual([]);
	});

	test("a link to a folder holding a credential is unsafe, and so is a link to home", () => {
		const keys = tempDir("ra-keys-");
		const folder = tempDir("ra-vend-");
		writeFileSync(join(keys, "id_rsa"), "key");
		writeFileSync(join(folder, "note.md"), "hi");
		symlinkSync(keys, join(folder, "vendor"));
		const scope = new ReadScope();
		rememberApprovedReads([folder], [], scope);
		expect(approvedGrants([folder], [])).toEqual([]);
		expect(isApprovedRead(join(folder, "note.md"), scope)).toBe(false);

		const homeLink = tempDir("ra-homelink-");
		symlinkSync(homedir(), join(homeLink, "h"));
		expect(approvedGrants([homeLink], [])).toEqual([]);
	});

	test("a link to a harmless folder, and a link back up the tree, keep the folder approved", () => {
		const other = tempDir("ra-harmless-");
		const folder = tempDir("ra-benign-");
		writeFileSync(join(other, "a.txt"), "a");
		writeFileSync(join(folder, "note.md"), "hi");
		symlinkSync(other, join(folder, "docs"));
		symlinkSync(folder, join(folder, "loop"));
		const scope = new ReadScope();
		rememberApprovedReads([folder], [], scope);
		expect(isApprovedRead(join(folder, "note.md"), scope)).toBe(true);
	});

	describe("depth findings from the security read of #4999", () => {
		const plant = (order: "deep-first" | "shallow-first") => {
			const folder = tempDir("ra-depth-");
			const x = tempDir("ra-depth-x-");
			mkdirSync(join(x, "sub"));
			writeFileSync(join(x, "sub", "id_rsa"), "key");
			mkdirSync(join(folder, "z", "b"), { recursive: true });
			const deep = () => symlinkSync(x, join(folder, "z", "b", "c"));
			const shallow = () => symlinkSync(x, join(folder, "a"));
			if (order === "deep-first") {
				deep();
				shallow();
			} else {
				shallow();
				deep();
			}
			return folder;
		};
		for (const order of ["deep-first", "shallow-first"] as const) {
			test(`a credential below a link target is seen when a shallow link follows a deep one (${order})`, () => {
				expect(approvedGrants([plant(order)], [])).toEqual([]);
			});
		}

		for (const [linkAt, rel] of [
			[3, "id_rsa"],
			[2, "p/id_rsa"],
			[1, "p/q/id_rsa"],
		] as const) {
			test(`a link at depth ${linkAt} to a folder holding ${rel} is unsafe`, () => {
				const folder = tempDir("ra-lk-");
				const out = tempDir("ra-lk-out-");
				mkdirSync(join(out, ...rel.split("/").slice(0, -1)), { recursive: true });
				writeFileSync(join(out, ...rel.split("/")), "key");
				const parent = join(folder, ...["x", "y"].slice(0, linkAt - 1));
				mkdirSync(parent, { recursive: true });
				symlinkSync(out, join(parent, "l"));
				expect(approvedGrants([folder], [])).toEqual([]);
			});
		}

		test("a link four levels down to a credential is unsafe, and grep -R shows the second card", async () => {
			const root = tempDir("ra-d4-root-");
			const base = join(homedir(), ".cache");
			mkdirSync(base, { recursive: true });
			const outside = mkdtempSync(join(base, "ra-d4-"));
			const keys = mkdtempSync(join(base, "ra-d4-keys-"));
			try {
				writeFileSync(join(keys, "id_rsa"), "key");
				mkdirSync(join(outside, "a", "b", "c"), { recursive: true });
				symlinkSync(join(keys, "id_rsa"), join(outside, "a", "b", "c", "lnk"));
				expect(approvedGrants([outside], [])).toEqual([]);
				let cards = 0;
				const ask = async () => {
					cards++;
					return true;
				};
				await runInReadScope(new ReadScope(), async () => {
					const run = (command: string) =>
						readBoundaryGate(command, {
							env: { EIGHT_WORKSPACE_ROOT: root },
							cwd: root,
							project: root,
							ask,
						});
					await run(`ls ${outside}`);
					await run(`grep -R k ${outside}`);
					expect(cards).toBe(2);
				});
			} finally {
				rmSync(outside, { recursive: true, force: true });
				rmSync(keys, { recursive: true, force: true });
			}
		});
	});

	describe("through readBoundaryGate, counting cards", () => {
		// The OS temp folder is an allowance of the boundary, so the approved folder lives under home.
		const homeDirs: string[] = [];
		const homeTemp = (prefix: string): string => {
			const base = join(homedir(), ".cache");
			mkdirSync(base, { recursive: true });
			const d = mkdtempSync(join(base, prefix));
			homeDirs.push(d);
			return d;
		};
		afterAll(() => {
			for (const d of homeDirs) rmSync(d, { recursive: true, force: true });
		});
		const setup = (target: "file" | "folder") => {
			const root = tempDir("ra-root-");
			const outside = homeTemp("ra-gate-out-");
			const target2 = homeTemp("ra-gate-tgt-");
			writeFileSync(join(target2, "id_rsa"), "key");
			writeFileSync(join(outside, "note.md"), "hi");
			symlinkSync(target === "file" ? join(target2, "id_rsa") : target2, join(outside, "lnk"));
			let cards = 0;
			const ask = async () => {
				cards++;
				return true;
			};
			const env = { EIGHT_WORKSPACE_ROOT: root };
			const run = (command: string) =>
				readBoundaryGate(command, { env, cwd: root, project: root, ask });
			return { outside, run, cards: () => cards };
		};

		for (const target of ["file", "folder"] as const) {
			test(`cat lnk/* and grep -R show a card after a yes, link to a ${target}`, async () => {
				const { outside, run, cards } = setup(target);
				await runInReadScope(new ReadScope(), async () => {
					await run(`ls ${outside}`);
					expect(cards()).toBe(1);
					await run(`cat ${outside}/lnk/*`);
					expect(cards()).toBe(2);
					await run(`grep -R k ${outside}`);
					expect(cards()).toBe(3);
				});
			});
		}

		test("a folder with only plain files is asked once, then not again", async () => {
			const root = tempDir("ra-root2-");
			const outside = homeTemp("ra-plain-");
			writeFileSync(join(outside, "note.md"), "hi");
			let cards = 0;
			const ask = async () => {
				cards++;
				return true;
			};
			const run = (command: string) =>
				readBoundaryGate(command, {
					env: { EIGHT_WORKSPACE_ROOT: root },
					cwd: root,
					project: root,
					ask,
				});
			await runInReadScope(new ReadScope(), async () => {
				await run(`ls ${outside}`);
				await run(`grep -R k ${outside}`);
				expect(cards).toBe(1);
			});
		});
	});
});
