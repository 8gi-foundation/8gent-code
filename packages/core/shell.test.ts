import { mkdtempSync, readFileSync, existsSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, describe, expect, test } from "bun:test";

import { killProcessTree, shellInvocation, spawnShell } from "./shell";

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
