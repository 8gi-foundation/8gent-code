/**
 * Pilot review (8SO): a shell command the model started outlived the TUI after
 * quit, because only its own timeout timer killed it and process.exit(0) kills
 * that timer. A registered group is ended by quit, and again by the exit handler.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { spawn } from "node:child_process";
import { spawnShell } from "../core/shell";
import { killLiveShells, liveShellCount, trackShell, untrackShell } from "./live-shells";

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
});
