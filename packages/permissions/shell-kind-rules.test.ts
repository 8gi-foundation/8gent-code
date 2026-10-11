import { describe, expect, test } from "bun:test";
import { withForcedShell } from "../core/shell";
import { readOnlyAllowlist } from "../decide/allowlist";
import { ModeManager } from "../eight/modes";
import { matchDenyList } from "./go-deny-list";
import { PermissionManager } from "./index";
import { classifyToolAction } from "./maker-checker-enforcer";
import { createPermissionHolder, planModeRefusal, runWithPermissionHolder } from "./permission-mode";
import { sanitizeShellCommand } from "./shell-sanitizer";
import { SHELL_TOOL_NAMES, posixRulesApply } from "./shell-tools";

const ps = { kind: "powershell" as const, file: "pwsh.exe" };
const PS1 = ["ls (Remove-Item -Recurse -Force src)", "echo (New-Item PWNED)", "cat @(Set-Content PWNED x)"];

describe("S1: PowerShell gets no opinion from the POSIX rule engines", () => {
	test("the read-only allowlist stays silent under pwsh", () => {
		for (const c of PS1) {
			expect(readOnlyAllowlist(c, { shell: "powershell" }).verdict).toBe("no-opinion");
			expect(sanitizeShellCommand(c, process.platform, "powershell").safe).toBe(false);
		}
		expect(readOnlyAllowlist("ls", { shell: "posix" }).verdict).toBe("pass-without-model");
	});

	test("PermissionManager does not pre-approve a PowerShell line", () => {
		const pm = new PermissionManager();
		for (const c of PS1) expect(pm.isAllowed(c, "powershell")).toBe(false);
		for (const c of PS1) expect(pm.checkPermission(c, "powershell")).not.toBe("allowed");
		expect(pm.isAllowed("ls", "posix")).toBe(true);
	});

	test("the forced shell reaches the default checks (powershell tool path)", () => {
		const pm = new PermissionManager();
		withForcedShell(ps, () => {
			expect(pm.isAllowed("ls")).toBe(false);
			expect(readOnlyAllowlist("ls").verdict).toBe("no-opinion");
		});
	});

	test("plan mode refuses a PowerShell line even when it looks read-only", async () => {
		const holder = createPermissionHolder("plan");
		const r = await runWithPermissionHolder(holder, () => planModeRefusal("powershell", { command: "ls" }));
		expect(r).not.toBeNull();
	});
});

describe("S2 S3: cmd.exe and line-break lines are not POSIX", () => {
	test("a cmd.exe line with ^ or %, or any CR/LF, is not judged by the POSIX rules", () => {
		expect(posixRulesApply("echo hi ^; touch PWNED", "cmd")).toBe(false);
		expect(posixRulesApply("echo %PATH%", "cmd")).toBe(false);
		expect(posixRulesApply("ls\ntouch PWNED", "git-bash")).toBe(false);
		expect(posixRulesApply("echo hi ^; touch x", "git-bash")).toBe(true);
	});
	test("the allowlist stays silent for those lines", () => {
		expect(readOnlyAllowlist("echo hi ^; touch PWNED", { shell: "cmd" }).verdict).toBe("no-opinion");
		expect(readOnlyAllowlist("ls\ntouch PWNED", { shell: "git-bash" }).verdict).toBe("no-opinion");
	});
});

describe("S4: one list of shell tools", () => {
	test("SHELL_TOOL_NAMES is run_command and powershell", () => {
		expect([...SHELL_TOOL_NAMES].sort()).toEqual(["powershell", "run_command"]);
	});
	test("every shell tool is classified by maker-checker, denied in architect and review, and in the /goal deny list", () => {
		const modes = new ModeManager("/nonexistent/modes.yaml");
		for (const tool of SHELL_TOOL_NAMES) {
			expect(classifyToolAction(tool, { command: "git push --force origin main" })).not.toBeNull();
			expect(modes.getMode("architect")?.deniedTools).toContain(tool);
			expect(modes.getMode("review")?.deniedTools).toContain(tool);
			expect(matchDenyList({ name: tool, args: { command: "curl https://api.stripe.com/v1/charges" } }).denied).toBe(true);
		}
	});
});
