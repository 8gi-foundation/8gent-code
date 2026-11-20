import { afterEach, describe, expect, test } from "bun:test";
import { spawn } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { resetCLIAgents, spawnCLIAgent } from "./universal-spawner";

const posix = process.platform !== "win32";

function alive(pid: number): boolean {
	try {
		process.kill(pid, 0);
		return true;
	} catch {
		return false;
	}
}

async function waitDead(pid: number, ms: number): Promise<boolean> {
	const end = Date.now() + ms;
	while (Date.now() < end) {
		if (!alive(pid)) return true;
		await new Promise((r) => setTimeout(r, 50));
	}
	return !alive(pid);
}

describe("spawnCLIAgent process group", () => {
	afterEach(() => resetCLIAgents());

	test.skipIf(!posix)("timeout kills the child and its grandchild", async () => {
		const agent = spawnCLIAgent("shell", "sleep 30 & echo $!; wait", { timeout: 1000 });
		const childPid = agent.process?.pid as number;
		expect(childPid).toBeGreaterThan(0);

		const result = await agent.promise;
		expect(result.timedOut).toBe(true);

		const grandchildPid = Number.parseInt(result.stdout.trim().split("\n")[0], 10);
		expect(grandchildPid).toBeGreaterThan(0);

		expect(await waitDead(childPid, 4000)).toBe(true);
		expect(await waitDead(grandchildPid, 4000)).toBe(true);
	}, 15000);

	test("a normal exit still resolves with output and exit code", async () => {
		const result = await spawnCLIAgent("shell", "echo hi; exit 3", { timeout: 5000 }).promise;
		expect(result.timedOut).toBe(false);
		expect(result.exitCode).toBe(3);
		expect(result.stdout.trim()).toBe("hi");
	});
});

describe("spawnCLIAgent parent exit", () => {
	for (const sig of ["SIGHUP", "SIGINT"] as const) {
		test.skipIf(!posix)(`${sig} to the parent's group does not orphan the child`, async () => {
			const dir = fs.mkdtempSync(path.join(os.tmpdir(), "spawner-pg-"));
			const script = path.join(dir, "parent.ts");
			fs.writeFileSync(
				script,
				`import { spawnCLIAgent } from ${JSON.stringify(path.join(import.meta.dir, "universal-spawner.ts"))};
console.log(spawnCLIAgent("shell", "sleep 40", { timeout: 60000 }).process?.pid);
setInterval(() => {}, 1000);
`,
			);
			// The parent leads its own group, as a terminal's foreground job does.
			const parent = spawn(process.execPath, [script], { detached: true, stdio: ["ignore", "pipe", "ignore"] });
			const exited = new Promise<void>((r) => parent.on("close", () => r()));
			try {
				const childPid = await new Promise<number>((resolve, reject) => {
					let buf = "";
					parent.stdout?.on("data", (d) => {
						buf += d.toString();
						if (buf.includes("\n")) resolve(Number.parseInt(buf.trim(), 10));
					});
					parent.on("error", reject);
					setTimeout(() => reject(new Error("no child pid")), 8000);
				});
				expect(alive(childPid)).toBe(true);
				process.kill(-(parent.pid as number), sig);
				await exited;
				expect(await waitDead(childPid, 4000)).toBe(true);
			} finally {
				try {
					process.kill(-(parent.pid as number), "SIGKILL");
				} catch {}
				fs.rmSync(dir, { recursive: true, force: true });
			}
		}, 20000);
	}
});

describe("spawnCLIAgent signal handler", () => {
	test.skipIf(!posix)("does not re-raise when another listener exists", async () => {
		const dir = fs.mkdtempSync(path.join(os.tmpdir(), "spawner-pg-"));
		const script = path.join(dir, "parent.ts");
		fs.writeFileSync(
			script,
			`import { spawnCLIAgent } from ${JSON.stringify(path.join(import.meta.dir, "universal-spawner.ts"))};
process.on("SIGTERM", () => {
	console.log("handled");
	setTimeout(() => process.exit(0), 400);
});
console.log(spawnCLIAgent("shell", "sleep 40", { timeout: 60000 }).process?.pid);
setInterval(() => {}, 1000);
`,
		);
		const parent = spawn(process.execPath, [script], { detached: true, stdio: ["ignore", "pipe", "ignore"] });
		let out = "";
		parent.stdout?.on("data", (d) => {
			out += d.toString();
		});
		const exited = new Promise<void>((r) => parent.on("close", () => r()));
		try {
			const end = Date.now() + 8000;
			while (!out.includes("\n") && Date.now() < end) await new Promise((r) => setTimeout(r, 25));
			const childPid = Number.parseInt(out.trim(), 10);
			expect(childPid).toBeGreaterThan(0);
			process.kill(parent.pid as number, "SIGTERM");
			await exited;
			expect(out.split("\n").filter((l) => l === "handled").length).toBe(1);
			expect(await waitDead(childPid, 4000)).toBe(true);
		} finally {
			try {
				process.kill(-(parent.pid as number), "SIGKILL");
			} catch {}
			fs.rmSync(dir, { recursive: true, force: true });
		}
	}, 20000);
});
