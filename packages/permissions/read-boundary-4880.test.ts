/**
 * #4880: nothing outside the working folder is read silently.
 *
 * Through the production entry points: the real ToolExecutor and the native (AI SDK) tools,
 * with real symlinks on disk, and run_command through ToolExecutor.runCommand -> systemOneGate
 * -> the TUI approval channel. The judge is a stub that blocks everything it is asked, so a
 * command that reaches it shows as a System One block; the boundary decides before that.
 *
 * The outside folder sits under the repo's .tmp/, not $TMPDIR: the temp folders are an
 * allowance, so a secret there would not test the boundary.
 */

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { agentTools, getToolContext, setToolContext } from "../ai/tools";
import { createDecider } from "../decide/index";
import type { DecideBackend, SystemOneRequest, SystemOneResponse } from "../decide/types";
import { ToolExecutor } from "../eight/tools";
import { resetReadAllow } from "./read-allow";
import { inlineCodePaths, outsideReads, readBoundaryOn } from "./read-boundary";
import { CreatedFiles } from "./s1-created-files";
import {
	SYSTEM_ONE_ALLOWLIST_FLAG,
	SYSTEM_ONE_FLAG,
	_resetSystemOne,
	_setSystemOneOverridesForTests,
	systemOneGate,
} from "./system-one-gate";
import { registerTuiApprovalHandler } from "./tui-approval-channel";

class AlwaysDangerous implements DecideBackend {
	readonly name = "stub";
	readonly model = "always-dangerous";
	asks = 0;
	async ask(request: SystemOneRequest): Promise<SystemOneResponse> {
		this.asks++;
		return {
			answers: [
				{
					id: request.questions[0].id,
					kind: "noul",
					probabilities: { yes: 0.99 },
					confidence: 0.99,
				},
			],
			backend: this.name,
			model: this.model,
			latencyMs: 0,
		};
	}
}

const SECRET = "SECRET-OUTSIDE-4880";
const KEYS = [
	SYSTEM_ONE_FLAG,
	SYSTEM_ONE_ALLOWLIST_FLAG,
	"EIGHT_HEADLESS",
	"EIGHT_WORKSPACE_ROOT",
	"EIGHT_WORKSPACE_BOUNDARY",
];
const saved: Record<string, string | undefined> = {};
const repoTmp = path.resolve(import.meta.dir, "..", "..", ".tmp");
let base: string;
let ws: string;
let outside: string;
let judge: AlwaysDangerous;
let cards: { action: string; command: string }[];
let answer: "approve" | "deny";
let ttyWas: PropertyDescriptor | undefined;

const priorContext = getToolContext();
type Exec = (args: Record<string, unknown>, opts: unknown) => Promise<string>;
const native = (tool: string, args: Record<string, unknown>) =>
	(agentTools[tool as keyof typeof agentTools] as unknown as { execute: Exec }).execute(args, {
		toolCallId: "t",
		messages: [],
	});
const exec = () => new ToolExecutor(ws, "rb-4880");
const run = (command: string) => exec().execute("run_command", { command });
async function settle(p: Promise<string>): Promise<string> {
	try {
		return String(await p);
	} catch (err) {
		return `THROWN: ${err instanceof Error ? err.message : String(err)}`;
	}
}

function interactive(reply: "approve" | "deny"): void {
	answer = reply;
	registerTuiApprovalHandler(async (req) => {
		cards.push({ action: String(req.action ?? ""), command: req.command ?? "" });
		return answer;
	});
	Reflect.deleteProperty(process.env, "EIGHT_HEADLESS");
}

function headless(): void {
	registerTuiApprovalHandler(null);
	process.env.EIGHT_HEADLESS = "1";
}

beforeAll(() => {
	for (const k of KEYS) saved[k] = process.env[k];
	for (const k of KEYS) Reflect.deleteProperty(process.env, k);
	fs.mkdirSync(repoTmp, { recursive: true });
	ttyWas = Object.getOwnPropertyDescriptor(process.stdin, "isTTY");
	Object.defineProperty(process.stdin, "isTTY", { value: false, configurable: true });
});

afterAll(() => {
	for (const k of KEYS) {
		if (saved[k] === undefined) Reflect.deleteProperty(process.env, k);
		else process.env[k] = saved[k];
	}
	if (ttyWas) Object.defineProperty(process.stdin, "isTTY", ttyWas);
	else Reflect.deleteProperty(process.stdin, "isTTY");
	registerTuiApprovalHandler(null);
	_resetSystemOne();
	setToolContext(priorContext);
});

beforeEach(() => {
	base = fs.realpathSync(fs.mkdtempSync(path.join(repoTmp, "rb4880-")));
	ws = path.join(base, "ws");
	outside = path.join(base, "outside");
	fs.mkdirSync(ws);
	fs.mkdirSync(outside);
	fs.writeFileSync(path.join(outside, "notes"), SECRET);
	fs.writeFileSync(path.join(outside, "leak.ts"), `export const LEAK = "${SECRET}";\n`);
	fs.writeFileSync(path.join(ws, "in.txt"), "INSIDE-OK");
	fs.writeFileSync(path.join(ws, "in.ts"), "export const inside = 1;\n");
	fs.symlinkSync("../outside/notes", path.join(ws, "s"));
	fs.symlinkSync("../outside/leak.ts", path.join(ws, "s.ts"));
	fs.symlinkSync("../outside", path.join(ws, "d"));
	fs.symlinkSync("in.txt", path.join(ws, "alias.txt"));
	cards = [];
	judge = new AlwaysDangerous();
	_setSystemOneOverridesForTests({
		createDecider: () => createDecider({ backend: judge, cacheSize: 0 }),
		calibrationDir: path.join(base, "nocal"),
	});
	resetReadAllow();
	setToolContext({ ...priorContext, workingDirectory: ws, createdFiles: new CreatedFiles() });
	headless();
});

afterEach(() => {
	registerTuiApprovalHandler(null);
	fs.rmSync(base, { recursive: true, force: true });
});

describe("hole 1: file tools follow links only to inside the workspace", () => {
	test("ToolExecutor read_file: a link to a file outside, a linked parent dir, and .. after a link", async () => {
		for (const p of ["s", "d/notes", "d/../outside/notes", path.join(ws, "d", "notes")]) {
			const out = await settle(exec().execute("read_file", { path: p }));
			expect(out).not.toContain(SECRET);
		}
		// `d/..` is the workspace parent to the OS; it is read lexically as the workspace itself.
		expect(await settle(exec().execute("read_file", { path: "d/../in.txt" }))).toContain(
			"INSIDE-OK",
		);
	});

	test("ToolExecutor read_file: in-root reads and in-root links still work", async () => {
		expect(await exec().execute("read_file", { path: "in.txt" })).toContain("INSIDE-OK");
		expect(await exec().execute("read_file", { path: "alias.txt" })).toContain("INSIDE-OK");
	});

	test("ToolExecutor read_file: a differently cased spelling of the root does not get past it", async () => {
		const upper = path.join(ws.toUpperCase(), "s");
		expect(await settle(exec().execute("read_file", { path: upper }))).not.toContain(SECRET);
	});

	test("native read_file refuses the same links", async () => {
		for (const p of ["s", "d/notes"]) {
			const out = await settle(native("read_file", { path: p }));
			expect(out).not.toContain(SECRET);
		}
		expect(await native("read_file", { path: "in.txt" })).toContain("INSIDE-OK");
	});

	test("ToolExecutor get_outline, get_symbol, read_notebook, read_pdf: links and outside paths refused", async () => {
		const tries: [string, Record<string, unknown>][] = [
			["get_outline", { filePath: "s.ts" }],
			["get_outline", { filePath: "d/leak.ts" }],
			["get_outline", { filePath: path.join(outside, "leak.ts") }],
			["get_symbol", { symbolId: "d/leak.ts::LEAK" }],
			["get_symbol", { symbolId: `${path.join(outside, "leak.ts")}::LEAK` }],
			["read_notebook", { path: "d/leak.ts" }],
			["read_pdf", { path: path.join(outside, "notes") }],
			["search_pdf", { path: "d/notes", query: "x" }],
		];
		for (const [tool, args] of tries) {
			const out = await settle(exec().execute(tool, args));
			expect(out).not.toContain(SECRET);
			expect(out).not.toContain("LEAK");
			expect(out).toMatch(/symlink|outside|cannot be read|traversal/i);
		}
		expect(await exec().execute("get_outline", { filePath: "in.ts" })).toContain("inside");
	});

	test("native get_outline, get_symbol and list_files refuse links and outside paths", async () => {
		for (const [tool, args] of [
			["get_outline", { filePath: "d/leak.ts" }],
			["get_symbol", { symbolId: "s.ts::LEAK" }],
			["list_files", { path: outside }],
		] as [string, Record<string, unknown>][]) {
			const out = await settle(native(tool, args));
			expect(out).not.toContain("LEAK");
			expect(out).not.toContain(SECRET);
			expect(out).toMatch(/symlink|outside|cannot be read|traversal/i);
			if (tool === "list_files") expect(out).not.toContain("notes");
		}
		expect(await native("get_outline", { filePath: "in.ts" })).toContain("inside");
	});

	test("search_files does not walk through a linked directory", async () => {
		expect(await exec().execute("search_files", { pattern: SECRET })).not.toContain(SECRET);
	});
});

describe("hole 2: run_command has a read boundary by default", () => {
	const OUTSIDE_READS = () => [
		"cat ../outside/notes",
		`cat ${path.join(outside, "notes")}`,
		`python3 -c "print(open('${path.join(outside, "notes")}').read())"`,
		`node -e "console.log(require('fs').readFileSync('../outside/notes','utf8'))"`,
	];

	test("headless: each outside read is refused, names the boundary, and runs nothing", async () => {
		headless();
		for (const c of OUTSIDE_READS()) {
			const out = await run(c);
			expect(out).not.toContain(SECRET);
			expect(out).toContain("[workspace-boundary]");
			expect(out).toContain("--allow-read");
		}
		expect(judge.asks).toBe(0);
	});

	test("interactive: each outside read asks first; a no runs nothing", async () => {
		interactive("deny");
		for (const c of OUTSIDE_READS()) {
			cards = [];
			const out = await run(c);
			expect(out).not.toContain(SECRET);
			expect(out).toContain("declined");
			expect(cards.length).toBe(1);
			expect(cards[0].action).toBe("Read outside the working folder");
		}
		expect(judge.asks).toBe(0);
	});

	test("interactive: a yes runs the read, with exactly one card", async () => {
		interactive("approve");
		const out = await run("cat ../outside/notes");
		expect(out).toContain(SECRET);
		expect(cards.length).toBe(1);
	});

	test("in-root reads run with no card, interactive or headless", async () => {
		headless();
		expect(await run("cat in.txt")).toContain("INSIDE-OK");
		interactive("deny");
		expect(await run("cat in.txt")).toContain("INSIDE-OK");
		expect(await run("head -1 ./in.txt")).toContain("INSIDE-OK");
		expect(cards).toEqual([]);
	});

	test("a cd prefix into a subfolder resolves relative paths from that folder", async () => {
		headless();
		fs.mkdirSync(path.join(ws, "sub"));
		expect(await run("cd sub && cat ../in.txt")).toContain("INSIDE-OK");
		expect(await run("cd sub && cat ../../outside/notes")).not.toContain(SECRET);
	});

	test("native run_command takes the same boundary", async () => {
		headless();
		const out = await native("run_command", { command: "cat ../outside/notes" });
		expect(out).not.toContain(SECRET);
		expect(out).toContain("[workspace-boundary]");
		expect(await native("run_command", { command: "cat in.txt" })).toContain("INSIDE-OK");
	});

	test("systemOneGate itself: the boundary holds with System One off", async () => {
		headless();
		const off = await systemOneGate(
			"cat ../outside/notes",
			{ ...process.env, [SYSTEM_ONE_FLAG]: "0" },
			ws,
			undefined,
			undefined,
			{ project: ws },
		);
		expect(off.run).toBe(false);
		expect(off.message).toContain("[workspace-boundary]");
	});

	test("widening: /allow-read on the folder, EIGHT_WORKSPACE_ROOT, or EIGHT_WORKSPACE_BOUNDARY=off", async () => {
		headless();
		const { addReadAllowDir } = await import("./read-allow");
		expect(addReadAllowDir(outside, ws)).toBe(outside);
		expect(await run("cat ../outside/notes")).toContain(SECRET);
		resetReadAllow();
		process.env.EIGHT_WORKSPACE_BOUNDARY = "off";
		try {
			expect(await run("cat ../outside/notes")).toContain(SECRET);
		} finally {
			Reflect.deleteProperty(process.env, "EIGHT_WORKSPACE_BOUNDARY");
		}
		const gate = await systemOneGate(
			"cat ../outside/notes",
			{ ...process.env, EIGHT_WORKSPACE_ROOT: base },
			ws,
			undefined,
			undefined,
			{ project: ws },
		);
		expect(gate.run).toBe(true);
	});
});

describe("allowances", () => {
	const home = os.homedir();
	const root = () => ws;
	const reads = (c: string) => outsideReads(c, { root: root() });

	test("normal dev flows name nothing outside", () => {
		for (const c of [
			"git config user.name",
			"git log --oneline -3",
			"ls node_modules/.bin",
			"echo hi > /dev/null 2>&1",
			"head -c 8 /dev/urandom",
			`cat ${path.join(os.tmpdir(), "build.log")}`,
			"cat /tmp/build.log",
			"ls ~/.8gent",
			`cat ${path.join(home, ".8gent", "config.json")}`,
			"ls /opt/homebrew/bin",
			"/usr/bin/env python3 -V",
			"bun test packages/x.test.ts",
			`python3 -c "print(open('in.txt').read())"`,
			'printf "%s" "${PATH:+yes}"',
			"kill $(lsof -t -i:3000)",
			"echo $(date)",
		]) {
			expect([c, reads(c)]).toEqual([c, []]);
		}
	});

	test("credentials, other projects and the tool's own secrets are outside", () => {
		// The test $HOME is a temp folder: make the files real, a path that does not exist is not a read.
		const h = process.env.HOME as string;
		for (const f of [
			".ssh/id_ed25519",
			".ssh/id_rsa",
			".aws/credentials",
			".gitconfig",
			".8gent/sessions/x.json",
			".8gent/telegram-token",
			".8gent/keys/signing.pem",
		]) {
			fs.mkdirSync(path.dirname(path.join(h, f)), { recursive: true });
			fs.writeFileSync(path.join(h, f), "x");
		}
		for (const c of [
			"cat ~/.ssh/id_ed25519",
			"cat ~/.aws/credentials",
			"cat ~/.gitconfig",
			"ls ../",
			"cat ~/.8gent/sessions/x.json",
			"cat ~/.8gent/telegram-token",
			"cat ~/.8gent/keys/signing.pem",
			"ls ~/.8gent/keys",
			`python3 -c "import os; print(open(os.path.expanduser('~/.ssh/id_rsa')).read())"`,
			"cat /etc/hosts",
			'cat "$(echo ~/.ssh/id_rsa)"',
			"cat `printf %s /etc/hosts`",
		]) {
			expect([c, reads(c).length > 0]).toEqual([c, true]);
		}
	});

	test("a path that does not exist is not a read (a sed script's w target, an output to come)", () => {
		expect(reads("sed -n 's/^Password: */password=/w .tmp/login' TASK.txt")).toEqual([]);
		expect(reads("cat /no-such-dir-4880/file")).toEqual([]);
	});

	test("inline code paths are only read from interpreter commands", () => {
		expect(inlineCodePaths(`python3 -c "open('/etc/passwd')"`)).toEqual(["/etc/passwd"]);
		expect(inlineCodePaths(`grep "'/etc/passwd'" notes.txt`)).toEqual([]);
	});

	test("EIGHT_WORKSPACE_BOUNDARY accepts off, 0, false and no", () => {
		for (const v of ["off", "0", "false", "no", "OFF"])
			expect(readBoundaryOn({ EIGHT_WORKSPACE_BOUNDARY: v })).toBe(false);
		for (const v of [undefined, "", "on", "1"])
			expect(readBoundaryOn({ EIGHT_WORKSPACE_BOUNDARY: v })).toBe(true);
	});
});
