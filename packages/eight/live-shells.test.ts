/**
 * Pilot review (8SO): a shell command the model started outlived the TUI after
 * quit, because only its own timeout timer killed it and process.exit(0) kills
 * that timer. A registered group is ended by quit, and again by the exit handler.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { spawn } from "node:child_process";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnShell } from "../core/shell";
import {
	killLiveShells,
	liveShellCount,
	settleShell,
	trackShell,
	untrackShell,
} from "./live-shells";

const alive = (pid: number) => {
	try {
		process.kill(pid, 0);
		return true;
	} catch {
		return false;
	}
};
const gone = async (pid: number, ms = 3000) => {
	const end = Date.now() + ms;
	while (Date.now() < end) {
		if (!alive(pid)) return true;
		await new Promise((r) => setTimeout(r, 25));
	}
	return !alive(pid);
};

const started: number[] = [];
afterEach(() => {
	for (const pid of started.splice(0)) {
		try {
			process.kill(-pid, "SIGKILL");
		} catch {}
		untrackShell(pid);
	}
});

function sleeper() {
	const child = spawnShell("sleep 60", { stdio: "ignore", processGroup: true });
	child.unref();
	started.push(child.pid as number);
	trackShell(child.pid);
	return child.pid as number;
}

describe("live shell registry", () => {
	test("quit (SIGTERM) ends a tracked command's whole group", async () => {
		const pid = sleeper();
		expect(alive(pid)).toBe(true);
		killLiveShells("SIGTERM");
		expect(await gone(pid)).toBe(true);
	});

	test("an untracked command is left alone", async () => {
		const pid = sleeper();
		untrackShell(pid);
		killLiveShells("SIGTERM");
		await new Promise((r) => setTimeout(r, 200));
		expect(alive(pid)).toBe(true);
	});

	test("SIGKILL clears the set", () => {
		sleeper();
		expect(liveShellCount()).toBeGreaterThan(0);
		killLiveShells("SIGKILL");
		expect(liveShellCount()).toBe(0);
	});

	test("process.exit(0) with a command still running leaves no process behind", async () => {
		// A real child process: tracks a sleeper, then exits with process.exit(0) at once,
		// the way quit does after its grace. The exit handler must kill the sleeper.
		const script = `
			import { spawnShell } from "${import.meta.dir}/../core/shell";
			import { trackShell } from "${import.meta.dir}/live-shells";
			const c = spawnShell("sleep 60", { stdio: "ignore", processGroup: true });
			c.unref();
			trackShell(c.pid);
			console.log(c.pid);
			process.exit(0);
		`;
		const host = spawn(process.execPath, ["-e", script], { stdio: ["ignore", "pipe", "inherit"] });
		let out = "";
		host.stdout.on("data", (d) => {
			out += d.toString();
		});
		await new Promise((r) => host.on("close", r));
		const pid = Number.parseInt(out.trim().split("\n").pop() ?? "", 10);
		expect(pid).toBeGreaterThan(1);
		started.push(pid);
		expect(await gone(pid)).toBe(true);
	});

	for (const sig of ["SIGHUP", "SIGTERM"] as const) {
		test(`${sig} with the TUI's re-raise handler installed leaves no process behind`, async () => {
			// The host dies by signal, so "exit" never fires. The handler app.tsx installs
			// (killBangsOnExit with killLiveShells("SIGKILL")) must kill the sleeper first.
			const script = `
				import { spawnShell } from "${import.meta.dir}/../core/shell";
				import { trackShell, killLiveShells } from "${import.meta.dir}/live-shells";
				import { killBangsOnExit } from "${import.meta.dir}/../../apps/tui/src/lib/bang-command";
				const c = spawnShell("sleep 60", { stdio: "ignore", processGroup: true });
				c.unref();
				trackShell(c.pid);
				killBangsOnExit(() => { killLiveShells("SIGKILL"); });
				console.log(c.pid);
				process.kill(process.pid, "${sig}");
				setTimeout(() => {}, 5000);
			`;
			const host = spawn(process.execPath, ["-e", script], {
				stdio: ["ignore", "pipe", "inherit"],
			});
			let out = "";
			host.stdout.on("data", (d) => {
				out += d.toString();
			});
			const code = await new Promise<string | null>((r) => host.on("close", (_c, s) => r(s)));
			expect(code).toBe(sig);
			const pid = Number.parseInt(out.trim().split("\n").pop() ?? "", 10);
			expect(pid).toBeGreaterThan(1);
			started.push(pid);
			expect(await gone(pid)).toBe(true);
		});
	}
});

describe("a command that outlives its leader (8SO follow-up)", () => {
	const pidFile = () => join(mkdtempSync(join(tmpdir(), "grandchild-")), "pid");
	const readPid = async (file: string) => {
		const end = Date.now() + 3000;
		while (Date.now() < end) {
			try {
				const n = Number.parseInt(readFileSync(file, "utf8").trim(), 10);
				if (n > 1) return n;
			} catch {}
			await new Promise((r) => setTimeout(r, 25));
		}
		throw new Error("grandchild pid never written");
	};

	test("a backgrounded grandchild with redirected output is gone after quit", async () => {
		const file = pidFile();
		const leader = spawnShell(`sh -c 'sleep 61 >/dev/null 2>&1 & echo $! > ${file}'`, {
			stdio: "ignore",
			processGroup: true,
		});
		leader.unref();
		started.push(leader.pid as number);
		trackShell(leader.pid);
		await new Promise((r) => leader.once("close", r));
		const grandchild = await readPid(file);
		started.push(grandchild);
		// The leader has closed. The old handler dropped the group here.
		settleShell(leader.pid);
		expect(alive(grandchild)).toBe(true);
		expect(liveShellCount()).toBeGreaterThan(0);
		killLiveShells("SIGTERM");
		expect(await gone(grandchild)).toBe(true);
	});

	test("once the whole group is gone, settle drops the pid", async () => {
		const child = spawnShell("true", { stdio: "ignore", processGroup: true });
		child.unref();
		trackShell(child.pid);
		await new Promise((r) => child.once("close", r));
		const before = liveShellCount();
		settleShell(child.pid);
		expect(liveShellCount()).toBe(before - 1);
	});

	test("a double-fork daemon that stays in the group is reached", async () => {
		const file = pidFile();
		const leader = spawnShell(`sh -c '(sleep 62 >/dev/null 2>&1 & echo $! > ${file}) &'`, {
			stdio: "ignore",
			processGroup: true,
		});
		leader.unref();
		started.push(leader.pid as number);
		trackShell(leader.pid);
		await new Promise((r) => leader.once("close", r));
		const daemon = await readPid(file);
		started.push(daemon);
		settleShell(leader.pid);
		killLiveShells("SIGTERM");
		expect(await gone(daemon)).toBe(true);
	});

	test("a stale registered pid never gets a bare kill", () => {
		const calls: Array<[number, NodeJS.Signals | 0]> = [];
		const kill = (pid: number, sig: NodeJS.Signals | 0) => {
			calls.push([pid, sig]);
			if (pid < 0) throw Object.assign(new Error("ESRCH"), { code: "ESRCH" });
		};
		trackShell(424242);
		killLiveShells("SIGTERM", { platform: "linux", kill });
		expect(calls).toEqual([[-424242, "SIGTERM"]]);
		expect(calls.some(([p]) => p > 0)).toBe(false);
		expect(liveShellCount()).toBe(0);
	});

	test("a real process that is not a group leader survives a stale registration", async () => {
		// Same process, spawned without its own group: pid exists, -pid does not.
		const bystander = spawn("sleep", ["63"], { stdio: "ignore" });
		started.push(bystander.pid as number);
		trackShell(bystander.pid);
		killLiveShells("SIGKILL");
		await new Promise((r) => setTimeout(r, 200));
		expect(alive(bystander.pid as number)).toBe(true);
		bystander.kill("SIGKILL");
	});
});
