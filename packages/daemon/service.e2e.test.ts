/**
 * Installs the real login service on a throwaway CI runner and drives it end
 * to end. It never runs on a developer machine: it needs EIGHT_SERVICE_E2E set
 * by the Platforms workflow and a GitHub-hosted runner, and it refuses macOS,
 * whose runner is a real person's machine.
 */

import { describe, expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import * as path from "node:path";
import { type ServiceContext, hostContext, runOperation, serviceStatus } from "./service";

const expected = process.env.EIGHT_SERVICE_E2E;
const enabled =
	(expected === "installed" || expected === "unavailable") &&
	process.env.RUNNER_ENVIRONMENT === "github-hosted" &&
	process.platform !== "darwin";

const HEALTH = "http://127.0.0.1:18789/health";

async function waitFor<T>(probe: () => Promise<T | null>, timeoutMs: number): Promise<T | null> {
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		const value = await probe();
		if (value !== null) return value;
		await Bun.sleep(1000);
	}
	return null;
}

const health = () =>
	fetch(HEALTH, { signal: AbortSignal.timeout(2000) })
		.then(async (r) => (r.ok ? ((await r.json()) as { status: string }) : null))
		.catch(() => null);

function daemonLogs(ctx: ServiceContext): string {
	return ["daemon.log", "daemon-error.log"]
		.map((f) => path.join(ctx.home, ".8gent", f))
		.filter((f) => existsSync(f))
		.map((f) => `--- ${f}\n${readFileSync(f, "utf8").slice(-4000)}`)
		.join("\n");
}

describe.skipIf(!enabled)("real login service on this runner", () => {
	const program = [
		process.execPath,
		path.resolve(import.meta.dir, "../../bin/8gent.ts"),
		"daemon",
		"run",
	];
	const ctx = hostContext(program);
	const quiet = () => {};

	test.if(expected === "unavailable")(
		"without systemd --user, every operation says so",
		async () => {
			const status = await serviceStatus(ctx);
			expect(status.state).toBe("unavailable");
			await expect(runOperation("install", ctx, quiet)).rejects.toThrow(
				"systemd user services are not available on this machine (common in WSL1 and containers). Run the daemon in the foreground instead: 8gent daemon run",
			);
			await runOperation("uninstall", ctx, quiet);
		},
	);

	test.if(expected === "installed")(
		"install, status, start, health, stop, uninstall",
		async () => {
			await runOperation("uninstall", ctx, quiet);
			expect(await serviceStatus(ctx)).toEqual({ state: "not-installed" });

			await runOperation("install", ctx, quiet);
			await runOperation("install", ctx, quiet);
			expect(["running", "stopped"]).toContain((await serviceStatus(ctx)).state);

			await runOperation("start", ctx, quiet);
			const body = await waitFor(health, 90_000);
			if (!body) console.log(daemonLogs(ctx));
			expect(body?.status).toBe("ok");
			expect((await serviceStatus(ctx)).state).toBe("running");

			await runOperation("stop", ctx, quiet);
			expect(await waitFor(async () => ((await health()) ? null : true), 30_000)).toBe(true);
			expect(await serviceStatus(ctx)).toEqual({ state: "stopped" });

			await runOperation("uninstall", ctx, quiet);
			await runOperation("uninstall", ctx, quiet);
			expect(await serviceStatus(ctx)).toEqual({ state: "not-installed" });
		},
		240_000,
	);
});
