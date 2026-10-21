/**
 * #4715: a file the person names in the ask can be read; a path that cannot be read says so
 * once and then stops the turn; chains of read-only commands run; the run cannot spawn itself.
 * Real ToolExecutor and native tools, System One with no judge (rules and allowlist only).
 */

import { afterAll, afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
	existsSync,
	mkdirSync,
	realpathSync,
	symlinkSync,
	unlinkSync,
	writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { cleanupTempDirs, tempDir } from "../../tests/temp-dirs";
import { agentTools, setToolContext } from "../ai/tools";
import { spawnsSelf } from "../permissions/pre-spawn-backstops";
import {
	CANNOT_READ_TEXT,
	addReadAllowDir,
	allowReadsFromPrompt,
	extractPromptPaths,
	readAllowEntries,
	resetReadAllow,
	runAllowReadCommand,
	takeBoundaryStop,
} from "../permissions/read-allow";
import { CreatedFiles } from "../permissions/s1-created-files";
import { _resetSystemOne, _setSystemOneOverridesForTests } from "../permissions/system-one-gate";
import { splitChain } from "./read-chain";
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
		expect(runAllowReadCommand([], cwd)).toContain(outside);
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
	])("refuses %s", async (cmd) => {
		expect(spawnsSelf(cmd)).toBe(true);
	});

	test.each([
		"8gent memory recall foo",
		"8gent --version",
		"echo 8gent chat",
		'grep -r "8gent run" .',
		"git commit -m '8gent chat fix'",
		"ls 8gent-code",
	])("allows %s", (cmd) => {
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
