import { mkdtempSync, readFileSync, existsSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, describe, expect, test } from "bun:test";

import { describeShell, killProcessTree, resolvePowerShell, resolveWindowsShell, shellInvocation, spawnShell, withoutShellStartupVars } from "./shell";

describe("shellInvocation", () => {
	test("posix runs the command with sh -c", () => {
		for (const platform of ["linux", "darwin"] as const) {
			expect(shellInvocation("git status && bun test", { platform })).toEqual({
				file: "sh",
				args: ["-c", "git status && bun test"],
				windowsVerbatimArguments: false,
			});
		}
	});

	test("posix honours a caller's shell and flags", () => {
		expect(shellInvocation("nvm use", { platform: "linux", posix: ["bash", "-lc"] })).toEqual({
			file: "bash",
			args: ["-lc", "nvm use"],
			windowsVerbatimArguments: false,
		});
	});

	test("win32 runs cmd.exe from ComSpec with the command as one verbatim quoted token", () => {
		expect(
			shellInvocation('git commit -m "fix it" && echo done', {
				platform: "win32",
				env: { ComSpec: "C:\\Windows\\system32\\cmd.exe" },
				posix: ["bash", "-lc"],
			}),
		).toEqual({
			file: "C:\\Windows\\system32\\cmd.exe",
			args: ["/d", "/s", "/c", '"git commit -m "fix it" && echo done"'],
			windowsVerbatimArguments: true,
		});
	});

	test("win32 falls back to cmd.exe on PATH when ComSpec is unset", () => {
		expect(shellInvocation("dir", { platform: "win32", env: {} }).file).toBe("cmd.exe");
	});
});

describe("killProcessTree", () => {
	const recorder = (platform: NodeJS.Platform, failGroup = false) => {
		const calls: string[] = [];
		killProcessTree(4242, "SIGTERM", {
			platform,
			kill: (pid, signal) => {
				calls.push(`kill ${pid} ${signal}`);
				if (failGroup && pid < 0) throw new Error("ESRCH");
			},
			runSync: (file, args) => calls.push([file, ...args].join(" ")),
		});
		return calls;
	};

	test("posix signals the process group", () => {
		expect(recorder("linux")).toEqual(["kill -4242 SIGTERM"]);
	});

	test("posix falls back to the pid when it leads no group", () => {
		expect(recorder("darwin", true)).toEqual(["kill -4242 SIGTERM", "kill 4242 SIGTERM"]);
	});

	test("win32 terminates the tree with taskkill", () => {
		expect(recorder("win32")).toEqual(["taskkill /pid 4242 /T /F"]);
	});
});

describe("real processes on this host", () => {
	const dir = mkdtempSync(path.join(tmpdir(), "8gent-shell-"));
	afterAll(() => rmSync(dir, { recursive: true, force: true }));

	const run = (command: string, timeoutMs: number) =>
		new Promise<{ stdout: string; code: number | null; timedOut: boolean }>((resolve) => {
			const child = spawnShell(command, { cwd: dir, stdio: ["ignore", "pipe", "pipe"], processGroup: true });
			let stdout = "";
			let timedOut = false;
			child.stdout?.on("data", (d: Buffer) => {
				stdout += d.toString();
			});
			const timer = setTimeout(() => {
				timedOut = true;
				killProcessTree(child.pid, "SIGKILL");
			}, timeoutMs);
			child.on("close", (code) => {
				clearTimeout(timer);
				resolve({ stdout, code, timedOut });
			});
		});

	const isAlive = (pid: number) => {
		try {
			process.kill(pid, 0);
			return true;
		} catch {
			return false;
		}
	};

	const waitUntil = async (predicate: () => boolean, ms: number) => {
		const deadline = Date.now() + ms;
		while (Date.now() < deadline) {
			if (predicate()) return true;
			await Bun.sleep(50);
		}
		return predicate();
	};

	// Only double quotes around the script, and none inside it, so the same
	// line parses identically in sh and cmd.exe.
	const bun = `"${process.execPath}"`;

	test("a command that chains and prints returns its output", async () => {
		const result = await run(`echo first && ${bun} -e "console.log('second')"`, 20_000);
		expect(result.timedOut).toBe(false);
		expect(result.code).toBe(0);
		expect(result.stdout.split(/\r?\n/).map((l) => l.trim()).filter(Boolean)).toEqual(["first", "second"]);
	});

	test("a timed-out command has its whole tree killed, grandchild included", async () => {
		const pidFile = path.join(dir, "grandchild.pid").replace(/\\/g, "/");
		const script = `require('fs').writeFileSync('${pidFile}', String(process.pid)); console.log('started'); setInterval(() => {}, 1000)`;
		const pending = run(`${bun} -e "${script}" && echo unreachable`, 3_000);

		expect(await waitUntil(() => existsSync(pidFile) && readFileSync(pidFile, "utf8").length > 0, 10_000)).toBe(true);
		const grandchild = Number(readFileSync(pidFile, "utf8"));

		const result = await pending;
		expect(result.timedOut).toBe(true);
		expect(result.stdout.trim()).toBe("started");
		expect(await waitUntil(() => !isAlive(grandchild), 5_000)).toBe(true);
	}, 30_000);
});

describe("resolveWindowsShell", () => {
	const only = (...files: string[]) => (p: string) => files.includes(p);
	const env = { ProgramFiles: "C:\\Program Files", Path: "C:\\Windows\\System32;C:\\tools", ComSpec: "C:\\Windows\\system32\\cmd.exe" };
	const gitBash = "C:\\Program Files\\Git\\bin\\bash.exe";
	const dll = "C:\\Program Files\\Git\\usr\\bin\\msys-2.0.dll";
	const workspace = "C:\\work\\repo";

	test("settings.shell.path wins when it is a local drive path that exists", () => {
		const shell = resolveWindowsShell({ env, workspace, shellPath: "D:\\sh\\bash.exe", exists: only("D:\\sh\\bash.exe", gitBash, dll) });
		expect(shell).toEqual({ kind: "git-bash", file: "D:\\sh\\bash.exe" });
	});

	test("a missing, relative or UNC settings.shell.path is ignored", () => {
		for (const shellPath of ["bash.exe", "\\\\203.0.113.5\\s\\bash.exe", "//host/s/bash.exe"]) {
			const shell = resolveWindowsShell({ env, workspace, shellPath, exists: () => true });
			expect(shell.file).not.toBe(shellPath);
		}
		expect(resolveWindowsShell({ env, workspace, shellPath: "D:\\gone\\bash.exe", exists: only(gitBash, dll) }).file).toBe(gitBash);
	});

	test("Git Bash under Program Files, inside a real Git root, is the default", () => {
		expect(resolveWindowsShell({ env, workspace, exists: only(gitBash, dll) })).toEqual({ kind: "git-bash", file: gitBash });
	});

	test("a bash.exe without msys-2.0.dll is not a Git root", () => {
		expect(resolveWindowsShell({ env, workspace, exists: only(gitBash) }).kind).toBe("cmd");
	});

	test("Git Bash is found next to git.exe on PATH", () => {
		const e = { ...env, ProgramFiles: undefined, Path: "C:\\Windows\\System32;D:\\Git\\cmd" };
		const shell = resolveWindowsShell({ env: e, workspace, exists: only("D:\\Git\\cmd\\git.exe", "D:\\Git\\bin\\bash.exe", "D:\\Git\\usr\\bin\\msys-2.0.dll") });
		expect(shell.kind).toBe("git-bash");
		expect(shell.file.toLowerCase()).toBe("d:\\git\\bin\\bash.exe");
	});

	test("a git.exe planted in node_modules or the workspace is never trusted", () => {
		const planted = ["C:\\work\\repo\\node_modules\\.bin", "C:\\work\\repo\\tools", "C:\\other\\node_modules\\.bin"];
		for (const dir of planted) {
			const bash = `${dir}\\..\\bin\\bash.exe`;
			const e = { ...env, ProgramFiles: undefined, Path: `${dir};C:\\Windows\\System32` };
			const shell = resolveWindowsShell({ env: e, workspace, exists: () => true });
			expect(shell.file.toLowerCase()).not.toContain("repo");
			expect(bash).toBeTruthy();
		}
	});

	test("relative PATH entries are ignored", () => {
		const shell = resolveWindowsShell({ env: { ...env, Path: ".;..\\bin" }, workspace, exists: () => true });
		expect(shell.file).not.toContain("..");
	});

	test("the WSL bash in System32 is never chosen", () => {
		expect(resolveWindowsShell({ env, workspace, exists: only("C:\\Windows\\System32\\bash.exe") }).kind).toBe("cmd");
	});

	test("falls back to PowerShell 7 (Program Files before PATH), then cmd.exe", () => {
		const pf = "C:\\Program Files\\PowerShell\\7\\pwsh.exe";
		expect(resolveWindowsShell({ env, workspace, exists: only("C:\\tools\\pwsh.exe") })).toEqual({ kind: "powershell", file: "C:\\tools\\pwsh.exe" });
		expect(resolveWindowsShell({ env, workspace, exists: only("C:\\tools\\pwsh.exe", pf) }).file).toBe(pf);
		expect(resolveWindowsShell({ env, workspace, exists: () => false })).toEqual({ kind: "cmd", file: env.ComSpec });
	});

	test("resolvePowerShell prefers Program Files, skips planted pwsh, then Windows PowerShell", () => {
		const e = { ...env, SystemRoot: "C:\\Windows", Path: "C:\\work\\repo\\node_modules\\.bin" };
		const ps = "C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe";
		const planted = "C:\\work\\repo\\node_modules\\.bin\\pwsh.exe";
		expect(resolvePowerShell({ env: e, workspace, exists: only(planted, ps) })).toEqual({ kind: "powershell", file: ps });
		const pf = "C:\\Program Files\\PowerShell\\7\\pwsh.exe";
		expect(resolvePowerShell({ env: e, workspace, exists: only(planted, pf, ps) })?.file).toBe(pf);
		expect(resolvePowerShell({ env: e, workspace, exists: () => false })).toBeUndefined();
	});

	test("describeShell names each shell in plain words", () => {
		expect(describeShell({ kind: "git-bash", file: "x" })).toBe("Git Bash");
		expect(describeShell({ kind: "cmd", file: "x" })).toBe("cmd.exe");
	});
});

describe("withoutShellStartupVars", () => {
	test("drops BASH_ENV and ENV in any case, keeps the rest", () => {
		const out = withoutShellStartupVars({ BASH_ENV: "C:\\evil.sh", env: "x", PATH: "p", Home: "h" });
		expect(out).toEqual({ PATH: "p", Home: "h" });
	});
});

describe("shellInvocation on Windows with a resolved shell", () => {
	test("Git Bash runs the command with -c, unquoted", () => {
		expect(
			shellInvocation("ls | grep x", { platform: "win32", windowsShell: { kind: "git-bash", file: "C:\\Git\\bin\\bash.exe" } }),
		).toEqual({ file: "C:\\Git\\bin\\bash.exe", args: ["-c", "ls | grep x"], windowsVerbatimArguments: false });
	});

	test("PowerShell runs with -NoProfile -NonInteractive -Command", () => {
		expect(
			shellInvocation("Get-Date", { platform: "win32", windowsShell: { kind: "powershell", file: "pwsh.exe" } }),
		).toEqual({
			file: "pwsh.exe",
			args: ["-NoProfile", "-NonInteractive", "-Command", "Get-Date"],
			windowsVerbatimArguments: false,
		});
	});

	test("an explicit cmd shell keeps the verbatim path", () => {
		const inv = shellInvocation("dir", { platform: "win32", windowsShell: { kind: "cmd", file: "cmd.exe" } });
		expect(inv.args).toEqual(["/d", "/s", "/c", '"dir"']);
		expect(inv.windowsVerbatimArguments).toBe(true);
	});
});
