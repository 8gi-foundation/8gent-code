import { describe, expect, test } from "bun:test";
import { withForcedShell } from "../core/shell";
import { readOnlyAllowlist } from "../decide/allowlist";
import { ModeManager } from "../eight/modes";
import { matchDenyList } from "./go-deny-list";
import { PermissionManager } from "./index";
import { classifyToolAction } from "./maker-checker-enforcer";
import {
	createPermissionHolder,
	planModeRefusal,
	runWithPermissionHolder,
} from "./permission-mode";
import { sanitizeShellCommand } from "./shell-sanitizer";
import { SHELL_TOOL_NAMES, posixRulesApply } from "./shell-tools";

const ps = { kind: "powershell" as const, file: "pwsh.exe" };
const PS1 = [
	"ls (Remove-Item -Recurse -Force src)",
	"echo (New-Item PWNED)",
	"cat @(Set-Content PWNED x)",
];

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
		const r = await runWithPermissionHolder(holder, () =>
			planModeRefusal("powershell", { command: "ls" }),
		);
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
	test("a line JS trim would shorten by more than spaces and tabs is not judged (8SO on #4185)", () => {
		// The shell keeps these in the word; the rules, reading command.trim(), would not.
		for (const ch of ["\u00a0", "\ufeff", "\u3000", "\u2028", "\u202f", "\v", "\f"]) {
			expect(posixRulesApply(`rm -rf .tmp${ch}`, "posix"), JSON.stringify(ch)).toBe(false);
			expect(posixRulesApply(`${ch}rm -rf .tmp`, "posix"), JSON.stringify(ch)).toBe(false);
			expect(readOnlyAllowlist(`ls${ch}`, { shell: "posix" }).verdict).toBe("no-opinion");
		}
		expect(posixRulesApply("  rm -rf .tmp \t ", "posix")).toBe(true);
		expect(posixRulesApply("echo a\u00a0b", "posix")).toBe(true);
	});
	test("the allowlist stays silent for those lines", () => {
		expect(readOnlyAllowlist("echo hi ^; touch PWNED", { shell: "cmd" }).verdict).toBe(
			"no-opinion",
		);
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
			expect(
				matchDenyList({ name: tool, args: { command: "curl https://api.stripe.com/v1/charges" } })
					.denied,
			).toBe(true);
		}
	});
});

describe("8SO: cmd.exe expansion tricks and PowerShell -EncodedCommand are refused in the sanitizer", () => {
	type K = "git-bash" | "cmd" | "powershell" | "posix";
	const refused = (c: string, kind: K) => sanitizeShellCommand(c, "win32", kind);
	const isRefused = (c: string, kind: K) => refused(c, kind).safe === false;

	test("cmd.exe %VAR:~n,m% substring expansion", () => {
		for (const c of [
			"echo %COMSPEC:~0,1%",
			"echo %PATH:~-3%",
			"echo %A:~1%%B:~2,1%",
			'echo "%COMSPEC:~0,1%"',
			"echo %COMS^PEC:~0,1%",
		]) {
			const r = refused(c, "cmd");
			expect(r.safe).toBe(false);
			expect(r.reason).toContain("%VAR:~n,m%");
		}
	});

	test("cmd.exe %VAR:a=b% replace expansion, including wildcard", () => {
		for (const c of ["echo %PATH:a=b%", "echo %X:*a=%", 'echo "%X:ab=cd%"'])
			expect(isRefused(c, "cmd")).toBe(true);
	});

	test("cmd.exe delayed expansion !VAR! forms", () => {
		for (const c of ["echo !COMSPEC!", "echo !COMSPEC:~0,1!", 'echo "!X:a=b!"', "echo ^!X^!"]) {
			const r = refused(c, "cmd");
			expect(r.safe).toBe(false);
			expect(r.reason).toContain("delayed expansion");
		}
	});

	test("a line that runs cmd from another shell kind is checked as cmd", () => {
		expect(isRefused('cmd /c "echo %COMSPEC:~0,1%"', "powershell")).toBe(true);
		expect(isRefused("cmd.exe /v:on /c echo !X!", "git-bash")).toBe(true);
		expect(isRefused('cmd /c "echo %X:a=b%"', "posix")).toBe(true);
	});

	test("near misses stay allowed: plain %VAR%, literal % and ! in text", () => {
		expect(isRefused("echo %PATH%", "cmd")).toBe(false);
		expect(isRefused('echo "100% sure"', "cmd")).toBe(false);
		expect(isRefused('echo "50%: done"', "cmd")).toBe(false);
		expect(isRefused("echo hello!", "cmd")).toBe(false);
		expect(isRefused('echo "wow! really!"', "cmd")).toBe(false);
		expect(isRefused("git commit -m 'bump 100% : fixed!'", "git-bash")).toBe(false);
		expect(isRefused("echo %PATH:x", "powershell")).toBe(false);
	});

	const ENC = [
		"e",
		"ec",
		"en",
		"enc",
		"enco",
		"encod",
		"encode",
		"encoded",
		"encodedc",
		"encodedco",
		"encodedcom",
		"encodedcomm",
		"encodedcomma",
		"encodedcomman",
		"encodedcommand",
	];

	test("PowerShell kind: -EncodedCommand and every prefix, any case, refused", () => {
		for (const p of ENC) {
			for (const flag of [`-${p}`, `-${p.toUpperCase()}`, `-${p[0].toUpperCase()}${p.slice(1)}`]) {
				const r = refused(`pwsh ${flag} SQBFAFgA`, "powershell");
				expect(r.safe).toBe(false);
				expect(r.reason).toContain("EncodedCommand");
			}
		}
		expect(isRefused("-enc SQBFAFgA", "powershell")).toBe(true);
		expect(isRefused("-enc:SQBFAFgA", "powershell")).toBe(true);
		expect(isRefused("-EncodedArguments abc", "powershell")).toBe(true);
	});

	test("powershell or pwsh invoked from any shell kind: dash and slash forms refused", () => {
		for (const kind of ["git-bash", "cmd", "powershell", "posix"] as const) {
			for (const p of ENC) {
				expect(isRefused(`powershell -${p} SQBFAFgA`, kind)).toBe(true);
				expect(isRefused(`pwsh.exe /${p.toUpperCase()} SQBFAFgA`, kind)).toBe(true);
			}
			expect(
				isRefused("powershell -NoProfile -NonInteractive -EncodedCommand SQBFAFgA", kind),
			).toBe(true);
			expect(
				isRefused(
					'"C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe" -ec SQBFAFgA',
					kind,
				),
			).toBe(true);
			expect(isRefused("powershell \u2013enc SQBFAFgA", kind)).toBe(true);
		}
	});

	test("quote, caret, backslash and variable tricks inside the flag name are refused (Karen's bypass cases)", () => {
		const cases = ['-"enc"', "-'e'nc", '-e""nc', "-\\enc", "-^enc", "-e^nc", "-e$Z"];
		for (const c of cases) {
			for (const prog of ["powershell", "pwsh"]) {
				for (const kind of ["powershell", "posix", "cmd", "git-bash"] as const) {
					const r = refused(`${prog} ${c} AAAA`, kind);
					expect(r.safe).toBe(false);
					expect(r.reason).toContain("EncodedCommand");
				}
			}
		}
		// any flag-like token with an expansion or escape character, even when it is not an encoded-command spelling
		for (const c of ["-Fo%X%", "-Fo!X!", "/e$Z", "\u2014e`nc", "-Out`File"]) {
			expect(isRefused(`powershell ${c} AAAA`, "posix")).toBe(true);
		}
	});

	test("near misses stay allowed: -Encoding on Out-File, -ExecutionPolicy, -Command, robocopy /e", () => {
		expect(isRefused("Get-Content a.txt | Out-File -Encoding utf8 b.txt", "powershell")).toBe(
			false,
		);
		expect(isRefused("Out-File -FilePath b.txt -Encoding utf8", "powershell")).toBe(false);
		expect(isRefused("Set-Content -Encoding UTF8 -Path b.txt -Value hi", "powershell")).toBe(false);
		expect(isRefused("pwsh -NoProfile -ExecutionPolicy Bypass -File build.ps1", "cmd")).toBe(false);
		expect(isRefused("pwsh -NoProfile -Command Get-Date", "git-bash")).toBe(false);
		expect(
			isRefused("powershell -NoProfile -Command Get-Date | Out-File -Encoding utf8 d.txt", "posix"),
		).toBe(false);
		expect(isRefused("robocopy a b /e", "powershell")).toBe(false);
		expect(isRefused("git log -e", "git-bash")).toBe(false);
		expect(isRefused("echo -e hi", "posix")).toBe(false);
		expect(isRefused("powershell -NoProfile -File C:\\tools\\run.ps1 -Name x", "posix")).toBe(
			false,
		);
	});
});
