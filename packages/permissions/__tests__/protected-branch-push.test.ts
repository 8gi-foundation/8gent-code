/**
 * Pushes to protected branches (main/master) are checked before the allow
 * list, auto-approve and infinite mode. Headless: denied. Interactive: the
 * approval card is shown and the person decides.
 */
import { afterAll, afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { cleanupTempDirs, tempDir } from "../../../tests/temp-dirs";
import { matchDenyList, matchGitPushProtectedBranch } from "../go-deny-list";
import { PermissionManager, isProtectedBranchPush } from "../index";
import { _resetTuiApprovalChannel, registerTuiApprovalHandler } from "../tui-approval-channel";

afterAll(cleanupTempDirs);

const PROTECTED = [
	"git push origin main",
	"git push origin master",
	"git push origin HEAD:main",
	"git push origin refs/heads/main",
	"git push origin HEAD:refs/heads/main",
	"git push -u origin main",
	"git push origin +main",
	"git push origin :main",
	"git -C /tmp/repo push origin main",
	"cd repo && git push origin main",
	"git push upstream feat/x main",
	"git push --all origin",
	"git push --mirror origin",
	"git push --force origin main",
];

const NOT_PROTECTED = [
	"git push origin feat/protected-branch-checks",
	"git push -u origin fix/main-page",
	"git push origin main-fix",
	"git push origin main:feat/copy",
	"git status",
	"git log --oneline main",
	"echo push main",
];

describe("protected-branch matcher", () => {
	for (const c of PROTECTED) {
		test(`matches: ${c}`, () => {
			expect(matchGitPushProtectedBranch(c)).toBe(true);
			expect(isProtectedBranchPush(c)).toBe(true);
		});
	}
	for (const c of NOT_PROTECTED) {
		test(`does not match: ${c}`, () => {
			expect(matchGitPushProtectedBranch(c)).toBe(false);
		});
	}
	test("the deny list still reports it under its own id", () => {
		expect(matchDenyList({ name: "run_command", args: "git push origin HEAD:main" }).pattern).toBe(
			"git-push-protected-branch",
		);
	});
});

const stdinTty = Object.getOwnPropertyDescriptor(process.stdin, "isTTY");
function setTty(value: boolean): void {
	Object.defineProperty(process.stdin, "isTTY", { value, configurable: true, writable: true });
}
const savedHeadless = process.env.EIGHT_HEADLESS;

function freshManager(): { pm: PermissionManager; configPath: string } {
	const configPath = join(tempDir("perm-protected-"), "permissions.json");
	return { pm: new PermissionManager(configPath), configPath };
}

const PUSHES = [
	"git push origin main",
	"git push origin master",
	"git push origin HEAD:main",
	"git push origin refs/heads/main",
];

describe("headless (no TTY)", () => {
	beforeEach(() => {
		setTty(false);
		Reflect.deleteProperty(process.env, "EIGHT_HEADLESS");
	});
	afterEach(() => {
		if (stdinTty) Object.defineProperty(process.stdin, "isTTY", stdinTty);
		else Reflect.deleteProperty(process.stdin, "isTTY");
		if (savedHeadless !== undefined) process.env.EIGHT_HEADLESS = savedHeadless;
	});

	test("default config: pushes to protected branches are denied, not allowed by `git *`", async () => {
		const { pm } = freshManager();
		expect(pm.getConfig().allowedPatterns).toContain("git *");
		for (const c of PUSHES) {
			expect(pm.checkPermission(c)).toBe("denied");
			expect(await pm.requestPermission("Execute Shell Command", "", c)).toBe(false);
		}
	});

	test("auto-approve (persisted or in-memory) never approves them", async () => {
		const { pm } = freshManager();
		pm.setAutoApprove(true, { persist: false });
		for (const c of PUSHES) expect(await pm.requestPermission("x", "y", c)).toBe(false);
		pm.setAutoApprove(true);
		for (const c of PUSHES) expect(await pm.requestPermission("x", "y", c)).toBe(false);
	});

	test("infinite mode never approves them", async () => {
		const { pm } = freshManager();
		pm.enableInfiniteMode();
		for (const c of PUSHES) {
			expect(pm.checkPermission(c)).toBe("denied");
			expect(await pm.requestPermission("x", "y", c)).toBe(false);
		}
		pm.disableInfiniteMode();
	});

	test("a feature-branch push is still allowed", async () => {
		const { pm } = freshManager();
		expect(pm.checkPermission("git push -u origin feat/x")).toBe("allowed");
		pm.setAutoApprove(true, { persist: false });
		expect(await pm.requestPermission("x", "y", "git push origin feat/x")).toBe(true);
	});

	test("force push is still not allowed", async () => {
		const { pm } = freshManager();
		pm.setAutoApprove(true, { persist: false });
		expect(pm.checkPermission("git push --force origin feat/x")).toBe("ask");
		expect(await pm.requestPermission("x", "y", "git push --force origin feat/x")).toBe(false);
	});

	test("setHeadless(true) denies even under a TTY", async () => {
		setTty(true);
		const { pm } = freshManager();
		pm.setHeadless(true);
		expect(pm.checkPermission("git push origin main")).toBe("denied");
		expect(await pm.requestPermission("x", "y", "git push origin main")).toBe(false);
	});
});

describe("interactive (TTY with the TUI card)", () => {
	const cards: string[] = [];
	beforeEach(() => {
		setTty(true);
		Reflect.deleteProperty(process.env, "EIGHT_HEADLESS");
		cards.length = 0;
	});
	afterEach(() => {
		_resetTuiApprovalChannel();
		if (stdinTty) Object.defineProperty(process.stdin, "isTTY", stdinTty);
		else Reflect.deleteProperty(process.stdin, "isTTY");
		if (savedHeadless !== undefined) process.env.EIGHT_HEADLESS = savedHeadless;
	});

	test("asks the person every time, even with auto-approve on, and honours the answer", async () => {
		const { pm } = freshManager();
		pm.setAutoApprove(true, { persist: false });
		let answer: "approve" | "deny" = "approve";
		registerTuiApprovalHandler(async (req) => {
			cards.push(req.command ?? "");
			return answer;
		});
		expect(pm.checkPermission("git push origin main")).toBe("ask");
		expect(await pm.requestPermission("x", "y", "git push origin main")).toBe(true);
		answer = "deny";
		expect(await pm.requestPermission("x", "y", "git push origin HEAD:main")).toBe(false);
		// approved once is not approved forever
		expect(pm.checkPermission("git push origin main")).toBe("ask");
		expect(cards).toEqual(["git push origin main", "git push origin HEAD:main"]);
	});
});

describe("setAutoApprove persistence", () => {
	test("persist: false never writes permissions.json", () => {
		const { pm, configPath } = freshManager();
		pm.setAutoApprove(true, { persist: false });
		expect(existsSync(configPath)).toBe(false);
	});
	test("the default (interactive /auto-approve toggle) still persists", () => {
		const { pm, configPath } = freshManager();
		pm.setAutoApprove(true);
		expect(JSON.parse(readFileSync(configPath, "utf-8")).autoApprove).toBe(true);
	});
});
