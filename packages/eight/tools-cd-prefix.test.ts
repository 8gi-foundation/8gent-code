/**
 * #3199 through the real run_command paths: a leading `cd <folder> &&` runs the rest in
 * that folder, and the rest meets every gate it would meet alone, judged in that folder.
 *
 * System One runs with no judge and no person to ask, as on a machine without the model:
 * its deterministic rules and lanes speak, and an escalate is a block. Same on every machine.
 */

import { afterAll, afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { cleanupTempDirs, tempDir } from "../../tests/temp-dirs";
import { agentTools, setToolContext } from "../ai/tools";
import { CreatedFiles } from "../permissions/s1-created-files";
import { _resetSystemOne, _setSystemOneOverridesForTests } from "../permissions/system-one-gate";
import { ToolExecutor } from "./tools";
const CHAIN_LEAD = "[BLOCKED] Send each command as its own run_command call.";

afterAll(() => {
	_resetSystemOne();
	cleanupTempDirs();
});

type PM = {
	checkPermission: (command: string) => "allowed" | "denied" | "ask";
	requestPermission: (action: string, details: string, command?: string) => Promise<boolean>;
};

const ENV_KEYS = ["EIGHT_SYSTEM_ONE", "EIGHT_COMMIT_GATE"];
const savedEnv: Record<string, string | undefined> = {};

let root = "";
let sub = "";
let executor: ToolExecutor;
let pm: PM;
let origCheck: PM["checkPermission"];
let origRequest: PM["requestPermission"];
let asked: string[];

beforeEach(() => {
	for (const k of ENV_KEYS) savedEnv[k] = process.env[k];
	Reflect.deleteProperty(process.env, "EIGHT_SYSTEM_ONE");
	root = realpathSync(tempDir("cd-prefix-exec-"));
	sub = join(root, "video");
	mkdirSync(join(sub, "old"), { recursive: true });
	writeFileSync(join(sub, "old", "keep.txt"), "keep");
	writeFileSync(join(sub, "slides.md"), "# slides");
	writeFileSync(join(root, "x.txt"), "root file");
	_setSystemOneOverridesForTests({
		createDecider: () => {
			throw new Error("no judge in this test");
		},
		askHuman: async () => null,
		calibrationDir: tempDir("cd-prefix-nocal-"),
	});
	executor = new ToolExecutor(root, "cd-prefix");
	pm = (executor as unknown as { permissionManager: PM }).permissionManager;
	origCheck = pm.checkPermission;
	origRequest = pm.requestPermission;
	asked = [];
	pm.checkPermission = () => "allowed";
	pm.requestPermission = async (_a, _d, command) => {
		asked.push(command ?? "");
		return true;
	};
});

afterEach(() => {
	pm.checkPermission = origCheck;
	pm.requestPermission = origRequest;
	for (const k of ENV_KEYS) {
		if (savedEnv[k] === undefined) Reflect.deleteProperty(process.env, k);
		else process.env[k] = savedEnv[k];
	}
});

// The verdict and the rule behind it. The hint after "The command was not run." names the
// path as written (`old` in the folder, `video/old` at the root), so it is left out.
const verdictOf = (out: string) => out.split(" The command was not run.")[0];

const run = (command: string) => executor.execute("run_command", { command }) as Promise<string>;

describe("ToolExecutor run_command with a leading cd", () => {
	test("`cd video && ls` runs ls inside video", async () => {
		const out = await run("cd video && ls");
		expect(out).toContain("slides.md");
		expect(out).not.toContain("x.txt");
	});

	test("the rest reaches System One exactly as it would alone, and is blocked the same way", async () => {
		const alone = await run("rm -rf video/old");
		expect(alone).toStartWith("[SYSTEM ONE BLOCKED]");
		const out = await run("cd video && rm -rf old");
		expect(out).toStartWith("[SYSTEM ONE BLOCKED]");
		expect(out).toEndWith("Command: rm -rf old");
		// The same rule, the same verdict: only the command text differs.
		expect(verdictOf(out)).toBe(verdictOf(alone));
		expect(existsSync(join(sub, "old", "keep.txt"))).toBe(true);
	});

	test("System One's rm lanes judge paths in the folder: x.txt is absent in video, so nothing is deleted", async () => {
		// Alone at the root, x.txt exists and is not this session's: blocked.
		expect(await run("rm -f x.txt")).toStartWith("[SYSTEM ONE BLOCKED]");
		// In video there is no x.txt: the rm-of-nothing lane passes it.
		const out = await run("cd video && rm -f x.txt");
		expect(out).not.toContain("BLOCKED");
		expect(readFileSync(join(root, "x.txt"), "utf-8")).toBe("root file");
	});

	test("a redirect target is recorded in the folder, so its own rm passes", async () => {
		process.env.EIGHT_SYSTEM_ONE = "0";
		expect(await run("cd video && cat slides.md > copy.md")).not.toContain("BLOCKED");
		Reflect.deleteProperty(process.env, "EIGHT_SYSTEM_ONE");
		expect(executor.createdFiles.createdBySession(join(sub, "copy.md"))).toBe(true);
		expect(await run("cd video && rm -f copy.md")).not.toContain("BLOCKED");
		expect(existsSync(join(sub, "copy.md"))).toBe(false);
	});

	test("a file a child process makes in a named subfolder is recorded (watchBorn gets the folder)", async () => {
		process.env.EIGHT_SYSTEM_ONE = "0";
		expect(await run("cd video && cp slides.md old/copy2.md")).not.toContain("BLOCKED");
		Reflect.deleteProperty(process.env, "EIGHT_SYSTEM_ONE");
		expect(executor.createdFiles.createdBySession(join(sub, "old", "copy2.md"))).toBe(true);
		expect(await run("cd video && rm -f old/copy2.md")).not.toContain("BLOCKED");
		expect(existsSync(join(sub, "old", "copy2.md"))).toBe(false);
	});

	test("`cd a && b; c`: the rest is refused for chaining and nothing runs", async () => {
		const out = await run("cd video && touch a.txt; touch b.txt");
		expect(out).toStartWith(CHAIN_LEAD);
		expect(out).toContain("Semicolon command chaining is not allowed");
		expect(existsSync(join(sub, "a.txt"))).toBe(false);
		expect(existsSync(join(sub, "b.txt"))).toBe(false);
	});

	test("a refused prefix runs nothing and asks no one", async () => {
		pm.checkPermission = () => "ask";
		for (const command of [
			"cd .. && touch z.txt",
			"cd /tmp && touch z.txt",
			"cd $HOME && touch z.txt",
		]) {
			const out = await run(command);
			expect(out, command).toStartWith(CHAIN_LEAD);
			expect(out, command).toContain("Command chaining is not allowed.");
		}
		expect(asked).toEqual([]);
		expect(existsSync(join(root, "z.txt"))).toBe(false);
	});

	test("the approval card is raised for the rest, as it would be alone, and names the folder", async () => {
		const where: (string | undefined)[] = [];
		const checkedIn: (string | undefined)[] = [];
		pm.checkPermission = ((_c: string, _s: unknown, w?: string) => {
			checkedIn.push(w);
			return "ask";
		}) as PM["checkPermission"];
		const spy = pm.requestPermission;
		pm.requestPermission = (async (a: string, d: string, c?: string, o?: { where?: string }) => {
			where.push(o?.where);
			return spy(a, d, c);
		}) as PM["requestPermission"];
		await run("cd video && ls");
		await run("ls");
		expect(asked).toEqual(["ls", "ls"]);
		expect(where).toEqual(["video", undefined]);
		expect(checkedIn).toEqual(["video", undefined]);
	});

	test("a System One escalation names the folder the rest runs in", async () => {
		const shown: string[] = [];
		_setSystemOneOverridesForTests({
			createDecider: () => {
				throw new Error("no judge in this test");
			},
			askHuman: async (r) => {
				shown.push(r.command);
				return false;
			},
			calibrationDir: tempDir("cd-prefix-nocal-"),
		});
		// A person can be asked (a TUI is up); askHuman above answers for them.
		const { registerTuiApprovalHandler } = await import("../permissions/tui-approval-channel");
		registerTuiApprovalHandler(async () => "deny");
		try {
			const o1 = await run("cd video && rm -rf old");
			expect(o1).toStartWith("[SYSTEM ONE BLOCKED]");
			expect(await run("rm -rf video/old")).toStartWith("[SYSTEM ONE BLOCKED]");
		} finally {
			registerTuiApprovalHandler(null);
		}
		expect(shown).toEqual(["cd video && rm -rf old", "rm -rf video/old"]);
		expect(existsSync(join(sub, "old", "keep.txt"))).toBe(true);
	});

	test("a commit behind a cd still meets the test-suite gate", async () => {
		let checked = 0;
		(executor as unknown as { commitGate: { check: () => Promise<unknown> } }).commitGate = {
			check: async () => {
				checked++;
				return { commit: false, message: "GATE REFUSED" };
			},
		};
		expect(await run("cd video && git commit -m wip")).toBe("GATE REFUSED");
		expect(checked).toBe(1);
	});
});

describe("native run_command with a leading cd", () => {
	const execute = (command: string) =>
		(
			agentTools.run_command as unknown as { execute: (i: unknown, o: unknown) => Promise<string> }
		).execute({ command }, {});

	beforeEach(() => {
		setToolContext({ workingDirectory: root, createdFiles: new CreatedFiles() });
	});

	test("`cd video && ls` runs ls inside video", async () => {
		const out = await execute("cd video && ls");
		expect(out).toContain("slides.md");
		expect(out).not.toContain("x.txt");
	});

	test("the rest reaches System One and is blocked as it would be alone", async () => {
		const alone = await execute("rm -rf video/old");
		const out = await execute("cd video && rm -rf old");
		expect(out).toStartWith("[SYSTEM ONE BLOCKED]");
		expect(verdictOf(out)).toBe(verdictOf(alone));
		expect(existsSync(join(sub, "old", "keep.txt"))).toBe(true);
	});

	test("a System One escalation names the folder the rest runs in", async () => {
		const shown: string[] = [];
		_setSystemOneOverridesForTests({
			createDecider: () => {
				throw new Error("no judge in this test");
			},
			askHuman: async (r) => {
				shown.push(r.command);
				return false;
			},
			calibrationDir: tempDir("cd-prefix-nocal-"),
		});
		const { registerTuiApprovalHandler } = await import("../permissions/tui-approval-channel");
		registerTuiApprovalHandler(async () => "deny");
		try {
			expect(await execute("cd video && rm -rf old")).toStartWith("[SYSTEM ONE BLOCKED]");
		} finally {
			registerTuiApprovalHandler(null);
		}
		expect(shown).toEqual(["cd video && rm -rf old"]);
		expect(existsSync(join(sub, "old", "keep.txt"))).toBe(true);
	});

	test("refused prefixes and chained rests run nothing", async () => {
		expect(await execute("cd .. && touch z.txt")).toStartWith(
			"[BLOCKED] Send each command as its own run_command call. Command chaining is not allowed.",
		);
		expect(await execute("cd video && touch a.txt; touch b.txt")).toStartWith(
			"[BLOCKED] Send each command as its own run_command call. Semicolon command chaining is not allowed",
		);
		expect(existsSync(join(sub, "a.txt"))).toBe(false);
	});
});

describe("the loop breaker counts a cd-prefixed command that runs (#3409)", () => {
	test("refusedBeforeRun: an accepted shape is a call, a refused one is not", async () => {
		const { refusedBeforeRun } = await import("./agent");
		expect(refusedBeforeRun("run_command", { command: "cd video && bash build.sh" })).toBe(false);
		expect(refusedBeforeRun("run_command", { command: "cd video && ls; ls" })).toBe(true);
		expect(refusedBeforeRun("run_command", { command: "cd .. && ls" })).toBe(true);
		expect(refusedBeforeRun("run_command", { command: "cd /tmp && ls" })).toBe(true);
		expect(refusedBeforeRun("powershell", { command: "cd video && ls" })).toBe(true);
	});
});

// #3199 review (8SO): `rm -rf old` or `make deploy` means a different thing in each
// folder, so a person's answer is remembered for the folder it was given in, and the
// card shows that folder. Policy still judges the command text alone.
// #4178: the card shows `cd <folder> && <rest>`, but that text is display only.
describe("the folder-first card changes nothing that is judged", () => {
	test("policy and the session memory still key on the rest and its folder, never the shown line", async () => {
		const { PermissionManager } = await import("../permissions");
		const { registerTuiApprovalHandler } = await import("../permissions/tui-approval-channel");
		const manager = new PermissionManager(join(tempDir("cd-prefix-parity-"), "permissions.json"));
		(manager as unknown as { isHeadless: () => boolean }).isHeadless = () => false;
		const shown: (string | undefined)[] = [];
		registerTuiApprovalHandler(async (r) => {
			shown.push(r.command);
			return "approve";
		});
		try {
			// A dangerous rest asks every time, before and after a yes, exactly as before #4178.
			const rm = "rm -rf old";
			expect(manager.checkPermission(rm, "posix", "video")).toBe("ask");
			expect(
				await manager.requestPermission("Execute Shell Command", "d", rm, { where: "video" }),
			).toBe(true);
			expect(manager.checkPermission(rm, "posix", "video")).toBe("ask");
			// A plain rest is remembered for its folder, keyed on the rest, not the shown line.
			const mk = "make deploy-4178";
			expect(manager.checkPermission(mk, "posix", "video")).toBe("ask");
			expect(
				await manager.requestPermission("Execute Shell Command", "d", mk, { where: "video" }),
			).toBe(true);
			expect(shown).toEqual(["cd video && rm -rf old", "cd video && make deploy-4178"]);
			expect(manager.checkPermission(mk, "posix", "video")).toBe("allowed");
			expect(manager.checkPermission(mk, "posix")).toBe("ask");
			expect(manager.checkPermission("cd video && make deploy-4178", "posix")).not.toBe("allowed");
		} finally {
			registerTuiApprovalHandler(null);
		}
	});
});

describe("session answers are kept per folder", () => {
	test("a yes in video is not a yes at the root or in another folder, and the card names video", async () => {
		const { PermissionManager } = await import("../permissions");
		const { registerTuiApprovalHandler } = await import("../permissions/tui-approval-channel");
		const manager = new PermissionManager(join(tempDir("cd-prefix-perm-"), "permissions.json"));
		(manager as unknown as { isHeadless: () => boolean }).isHeadless = () => false;
		const shown: (string | undefined)[] = [];
		registerTuiApprovalHandler(async (r) => {
			shown.push(r.command);
			return "approve";
		});
		try {
			const cmd = "make deploy-site-3199";
			expect(manager.checkPermission(cmd, "posix", "video")).toBe("ask");
			expect(
				await manager.requestPermission("Execute Shell Command", "d", cmd, { where: "video" }),
			).toBe(true);
			expect(shown).toEqual([`cd video && ${cmd}`]);
			expect(manager.checkPermission(cmd, "posix", "video")).toBe("allowed");
			expect(manager.checkPermission(cmd, "posix")).toBe("ask");
			expect(manager.checkPermission(cmd, "posix", "site")).toBe("ask");
			// A yes at the root does not carry into a folder either.
			await manager.requestPermission("Execute Shell Command", "d", cmd);
			expect(shown.at(-1)).toBe(cmd);
			expect(manager.checkPermission(cmd, "posix")).toBe("allowed");
			expect(manager.checkPermission(cmd, "posix", "site")).toBe("ask");
		} finally {
			registerTuiApprovalHandler(null);
		}
	});

	test("on a case-insensitive disk `cd VIDEO` hands every gate the folder's real name", async () => {
		const { cdPrefix, folderLabel } = await import("../permissions/cd-prefix");
		const cd = cdPrefix("cd VIDEO && ls", root);
		if (cd.kind !== "cd") {
			// A case-sensitive disk: there is no VIDEO, so it is refused.
			expect(cd.kind).toBe("refused");
			return;
		}
		expect(cd.dir).toBe(sub);
		expect(folderLabel(cd.dir, root)).toBe("video");
	});
});

// #4260: env-setup-practice sent `cd inbox && mkdir -p notes docs sheets && mv -n ...`. The
// rest was refused for chaining and the refusal named only the rest, so the model resent
// the pieces bare: they ran at the project root and the files left inbox/. The refusal now
// keeps the folder. It allows nothing new: every chained rest is still refused and runs nothing.
describe("a chained rest after a cd prefix is refused with its folder (#4260)", () => {
	const inbox = () => join(root, "inbox");
	beforeEach(() => {
		mkdirSync(join(root, "inbox"));
		mkdirSync(join(root, "notes"));
		writeFileSync(join(root, "notes", "README.md"), "clone");
		for (const f of ["note-1.txt", "doc-1.md", "sheet-1.csv"])
			writeFileSync(join(root, "inbox", f), f);
	});

	const PILOT_LINE =
		"cd inbox && mkdir -p notes docs sheets && mv -n note-*.txt notes/ && mv -n doc-*.md docs/ && mv -n sheet-*.csv sheets/";

	test("the pilot's line is still refused, runs nothing, and the refusal names the folder", async () => {
		const out = await run(PILOT_LINE);
		expect(out).toStartWith(CHAIN_LEAD);
		expect(out).toContain("Command chaining with && is not allowed");
		expect(out).toContain("begin every piece with `cd inbox &&`");
		expect(out).toEndWith(`Command: ${PILOT_LINE}`);
		for (const d of ["notes", "docs", "sheets"]) expect(existsSync(join(inbox(), d))).toBe(false);
		expect(existsSync(join(root, "docs"))).toBe(false);
		expect(readFileSync(join(inbox(), "note-1.txt"), "utf-8")).toBe("note-1.txt");
	});

	test("known-bad chained rests stay refused and run nothing", async () => {
		for (const command of [
			"cd inbox && mkdir docs; mv -n doc-1.md docs/",
			"cd inbox && mkdir docs || mv -n doc-1.md docs/",
			"cd inbox && mkdir docs & mv -n doc-1.md docs/",
			"cd inbox && mkdir docs && mv -n doc-1.md docs/",
			"cd inbox && mkdir docs && rm -f doc-1.md",
		]) {
			const out = await run(command);
			expect(out).toStartWith("[BLOCKED]");
			expect(out).toContain("`cd inbox &&`");
			expect(existsSync(join(inbox(), "docs"))).toBe(false);
			expect(existsSync(join(inbox(), "doc-1.md"))).toBe(true);
		}
		expect(asked).toEqual([]);
	});

	test("a chain at the project root keeps the old refusal, with no folder note", async () => {
		const out = await run("mkdir -p docs && mv -n inbox/doc-1.md docs/");
		expect(out).toStartWith(CHAIN_LEAD);
		expect(out).not.toContain("begin every piece");
		expect(out).toEndWith("Command: mkdir -p docs && mv -n inbox/doc-1.md docs/");
		expect(existsSync(join(root, "docs"))).toBe(false);
	});

	test("the pieces resent as the refusal says land the files inside inbox/", async () => {
		for (const command of [
			"cd inbox && mkdir -p notes docs sheets",
			"cd inbox && mv -n note-*.txt notes/",
			"cd inbox && mv -n doc-*.md docs/",
			"cd inbox && mv -n sheet-*.csv sheets/",
		]) {
			expect(await run(command)).not.toContain("BLOCKED");
		}
		expect(readFileSync(join(inbox(), "notes", "note-1.txt"), "utf-8")).toBe("note-1.txt");
		expect(readFileSync(join(inbox(), "docs", "doc-1.md"), "utf-8")).toBe("doc-1.md");
		expect(readFileSync(join(inbox(), "sheets", "sheet-1.csv"), "utf-8")).toBe("sheet-1.csv");
		expect(existsSync(join(root, "notes", "note-1.txt"))).toBe(false);
	});
});
