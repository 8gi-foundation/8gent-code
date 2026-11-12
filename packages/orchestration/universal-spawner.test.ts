import { afterEach, describe, expect, test } from "bun:test";
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
