import { afterAll, afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SessionManager } from "../eight/session-manager";
import { appendRecord, wasInterrupted } from "../specifications/session/durable-ledger";
import { PermissionManager } from "./index";
import {
	createPermissionHolder,
	effectivePermissionMode,
	runWithPermissionHolder,
} from "./permission-mode";
import {
	MAX_DENIALS_PER_SESSION,
	MAX_DENIAL_FILES,
	denialDir,
	readDenials,
	recordDenial,
	resumeLaunchMode,
	resumeReturnQuestion,
} from "./resume-safety";
import { registerTuiApprovalHandler } from "./tui-approval-channel";

const dirs: string[] = [];
const savedEnv = { ...process.env };
const savedTTY = process.stdin.isTTY;
let data: string;

beforeEach(() => {
	data = mkdtempSync(join(tmpdir(), "resume-safety-"));
	dirs.push(data);
	process.env.EIGHT_DATA_DIR = data;
	process.env.EIGHT_HEADLESS = "";
	(process.stdin as { isTTY?: boolean }).isTTY = true;
});
afterEach(() => {
	registerTuiApprovalHandler(null);
	process.env = { ...savedEnv };
	(process.stdin as { isTTY?: boolean }).isTTY = savedTTY;
});
afterAll(() => {
	for (const d of dirs) rmSync(d, { recursive: true, force: true });
});

const manager = () => new PermissionManager(join(data, "permissions.json"));

/** Every file under the data dir, as one string. */
function everythingOnDisk(): string {
	const out: string[] = [];
	const walk = (d: string) => {
		for (const e of readdirSync(d, { withFileTypes: true })) {
			const p = join(d, e.name);
			if (e.isDirectory()) walk(p);
			else out.push(`${p}\n${readFileSync(p, "utf8")}`);
		}
	};
	walk(data);
	return out.join("\n");
}

describe("C2: a resume after an interrupted turn starts in the stricter mode", () => {
	test("crash in Infinite, then resume: starts in Ask and asks once", () => {
		const start = resumeLaunchMode({ launch: "infinite", interrupted: true });
		expect(start).toEqual({ mode: "ask", clamped: true });
		const holder = createPermissionHolder(start.mode);
		expect(effectivePermissionMode(holder)).toBe("ask");
		expect(resumeReturnQuestion(false)).toContain("Infinite");
		expect(resumeReturnQuestion(true)).toContain("yolo");
	});

	test("a real killed turn in the durable ledger is what clamps the resume", () => {
		process.env.HOME = data;
		const at = new Date().toISOString();
		// Infinite session: a turn starts, a command goes out, the process is killed.
		appendRecord("killed-1", { k: "turn", at, msg: "deploy it" });
		appendRecord("killed-1", {
			k: "intent",
			id: "c1",
			tool: "run_command",
			argsHash: "h",
			key: "killed-1:c1",
			at,
		});
		const interrupted = wasInterrupted;
		expect(interrupted("killed-1")).toBe(true);
		expect(
			resumeLaunchMode({ launch: "infinite", interrupted: interrupted("killed-1") }).mode,
		).toBe("ask");
		// A session that finished its turn, and one never seen, keep the launch mode.
		appendRecord("done-1", { k: "turn", at, msg: "hi" });
		appendRecord("done-1", { k: "end", how: "done", at });
		expect(interrupted("done-1")).toBe(false);
		expect(interrupted("never-seen")).toBe(false);
	});

	test("a fresh start keeps the launch mode, yolo included", () => {
		expect(resumeLaunchMode({ launch: "infinite", interrupted: false })).toEqual({
			mode: "infinite",
			clamped: false,
		});
		expect(resumeLaunchMode({ launch: "ask", interrupted: false }).clamped).toBe(false);
	});

	test("never loosens: Plan stays Plan and nothing is asked; Guarded drops to Ask", () => {
		expect(resumeLaunchMode({ launch: "plan", interrupted: true })).toEqual({
			mode: "plan",
			clamped: false,
		});
		expect(resumeLaunchMode({ launch: "guarded", interrupted: true })).toEqual({
			mode: "ask",
			clamped: true,
		});
	});
});

describe("C2 holds on every resume path, decided from the resolved session id", () => {
	test("by name, by id prefix, by exact id and through openStoredSession all start in Ask", () => {
		process.env.HOME = data;
		const mgr = new SessionManager(join(data, "sessions"));
		const info = mgr.create({ name: "nightly-deploy" });
		const at = new Date().toISOString();
		appendRecord(info.id, { k: "turn", at, msg: "go" });
		appendRecord(info.id, {
			k: "intent",
			id: "c1",
			tool: "run_command",
			argsHash: "h",
			key: `${info.id}:c1`,
			at,
		});
		const resolved = [
			mgr.resume("nightly")?.id, // by name prefix
			mgr.resume(info.id.slice(0, 4))?.id, // by id prefix
			mgr.resume(info.id)?.id, // by exact id
			mgr.get(info.id)?.id, // openStoredSession: picker, import, history
		];
		for (const id of resolved) {
			expect(id).toBe(info.id);
			expect(
				resumeLaunchMode({ launch: "infinite", interrupted: wasInterrupted(id as string) }),
			).toEqual({
				mode: "ask",
				clamped: true,
			});
		}
	});
});

describe("C3: a denied call is not re-run on resume without a fresh decision", () => {
	test("denied, crash, resume with --durable-retry (no terminal, Infinite, --yes): still refused", async () => {
		const before = manager();
		before.setDenialSession("sess-1");
		registerTuiApprovalHandler(async () => "deny");
		expect(await before.requestPermission("run", "deploytool --apply", "deploytool --apply")).toBe(
			false,
		);

		// The crash: a new process, same session id, headless, Infinite and --yes on.
		registerTuiApprovalHandler(null);
		process.env.EIGHT_HEADLESS = "1";
		const after = manager();
		const shown = after.setDenialSession("sess-1");
		expect(shown.map((d) => d.hint)).toEqual(["deploytool --apply"]);
		after.enableInfiniteMode();
		after.setAutoApprove(true);
		expect(await after.requestPermission("run", "deploytool --apply", "deploytool --apply")).toBe(
			false,
		);
	});

	test("interactive resume asks once; a fresh yes runs it and clears the denial", async () => {
		const before = manager();
		before.setDenialSession("sess-2");
		registerTuiApprovalHandler(async () => "deny");
		await before.requestPermission("run", "deploytool --apply", "deploytool --apply");

		const after = manager();
		after.setDenialSession("sess-2");
		after.enableInfiniteMode();
		let asked = 0;
		registerTuiApprovalHandler(async () => {
			asked++;
			return "approve";
		});
		expect(await after.requestPermission("run", "deploytool --apply", "deploytool --apply")).toBe(
			true,
		);
		expect(asked).toBe(1);
		expect(readDenials("sess-2")).toEqual([]);
		// Decided: the next call is the manager's normal Infinite path, no second card.
		expect(await after.requestPermission("run", "deploytool --apply", "deploytool --apply")).toBe(
			true,
		);
		expect(asked).toBe(1);
	});

	test("extra spaces and a leading cd do not slip past a denial", async () => {
		const before = manager();
		before.setDenialSession("sess-var");
		registerTuiApprovalHandler(async () => "deny");
		await before.requestPermission("run", "x", "deploytool --apply");
		registerTuiApprovalHandler(null);
		process.env.EIGHT_HEADLESS = "1";
		const after = manager();
		after.setDenialSession("sess-var");
		after.enableInfiniteMode();
		after.setAutoApprove(true);
		for (const spelling of [
			"deploytool  --apply",
			"cd /tmp && deploytool --apply",
			"DeployTool\t--apply",
		])
			expect(await after.requestPermission("run", "x", spelling)).toBe(false);
	});

	test("an unrelated command in the same resumed session is not affected", async () => {
		const before = manager();
		before.setDenialSession("sess-3");
		registerTuiApprovalHandler(async () => "deny");
		await before.requestPermission("run", "deploytool --apply", "deploytool --apply");
		const after = manager();
		after.setDenialSession("sess-3");
		after.enableInfiniteMode();
		registerTuiApprovalHandler(async () => {
			throw new Error("no card expected");
		});
		expect(await after.requestPermission("run", "ls", "ls")).toBe(true);
	});

	test("denials are scoped to their session", async () => {
		const a = manager();
		a.setDenialSession("sess-a");
		registerTuiApprovalHandler(async () => "deny");
		await a.requestPermission("run", "deploytool --apply", "deploytool --apply");
		const b = manager();
		expect(b.setDenialSession("sess-b")).toEqual([]);
		expect(b.setDenialSession("../escape")).toEqual([]);
	});
});

describe("approvals are never written to disk", () => {
	test("approved calls leave no file and no trace of the command", async () => {
		const pm = manager();
		pm.setDenialSession("sess-ok");
		registerTuiApprovalHandler(async () => "approve");
		expect(
			await pm.requestPermission(
				"run",
				"runtool approved-secret-cmd",
				"runtool approved-secret-cmd",
			),
		).toBe(true);
		pm.enableInfiniteMode();
		expect(await pm.requestPermission("run", "runtool second-cmd", "runtool second-cmd")).toBe(
			true,
		);
		expect(existsSync(denialDir())).toBe(false);
		expect(everythingOnDisk()).not.toContain("approved-secret-cmd");
		expect(everythingOnDisk()).not.toContain("second-cmd");
	});

	test("the denial file holds a fingerprint and a hint only, never an approval or the raw command", async () => {
		const pm = manager();
		pm.setDenialSession("sess-mix");
		registerTuiApprovalHandler(async (r) => (r.command?.includes("keep") ? "approve" : "deny"));
		await pm.requestPermission("run", "keeptool --keep-me", "keeptool --keep-me");
		await pm.requestPermission(
			"run",
			"pushtool https://u:pw@host/x?token=abc",
			"pushtool https://u:pw@host/x?token=abc",
		);
		const disk = everythingOnDisk();
		expect(disk).not.toContain("keep-me");
		expect(disk).not.toContain("pw@");
		expect(disk).not.toContain("token=abc");
		expect(disk.toLowerCase()).not.toContain("approve");
		expect(readDenials("sess-mix")).toHaveLength(1);
	});
});

describe("the ledger is bounded", () => {
	test("rows per session and files are capped, the newest kept", () => {
		for (let i = 0; i < MAX_DENIALS_PER_SESSION + 20; i++) recordDenial("sess-big", `cmd ${i}`);
		const rows = readDenials("sess-big");
		expect(rows).toHaveLength(MAX_DENIALS_PER_SESSION);
		expect(rows.at(-1)?.hint).toBe(`cmd ${MAX_DENIALS_PER_SESSION + 19}`);
		for (let i = 0; i < MAX_DENIAL_FILES + 10; i++) recordDenial(`sess-${i}`, "x");
		expect(readdirSync(denialDir()).filter((f) => f.endsWith(".json")).length).toBeLessThanOrEqual(
			MAX_DENIAL_FILES,
		);
	});

	test("a hint is cut to 120 characters", () => {
		recordDenial("sess-long", "echo " + "a".repeat(500));
		expect(readDenials("sess-long")[0]?.hint.length).toBe(120);
	});
});
