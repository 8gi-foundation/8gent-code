/**
 * Wiring: run_command registers its process group with live-shells, so quit
 * (killLiveShells) ends a long command the model started, and the registry is
 * empty again once the command is done.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { killLiveShells, liveShellCount } from "./live-shells";
import { ToolExecutor } from "./tools";

type Hooks = { executeHooks: (type: string, data: unknown) => Promise<unknown> };
type PM = { checkPermission: (command: string) => string };

let ws: string;
let executor: ToolExecutor;
let pm: PM;
let hooks: Hooks;
let origCheck: PM["checkPermission"];
let origHooks: Hooks["executeHooks"];

beforeEach(() => {
	ws = realpathSync(mkdtempSync(join(tmpdir(), "live-shell-")));
	executor = new ToolExecutor(ws, "live-shell");
	pm = (executor as unknown as { permissionManager: PM }).permissionManager;
	hooks = (executor as unknown as { hookManager: Hooks }).hookManager;
	origCheck = pm.checkPermission;
	origHooks = hooks.executeHooks;
	pm.checkPermission = () => "allowed";
	hooks.executeHooks = async () => undefined;
});
afterEach(() => {
	killLiveShells("SIGKILL");
	pm.checkPermission = origCheck;
	hooks.executeHooks = origHooks;
	rmSync(ws, { recursive: true, force: true });
});

/**
 * A group that is dying can still exist when the command's close fires, so it
 * stays registered until the next sweep (up to 2 s). Wait for the registry to
 * empty instead of reading it the instant the command returns.
 */
async function registryEmpties(withinMs = 3000): Promise<number> {
	const end = Date.now() + withinMs;
	while (liveShellCount() > 0 && Date.now() < end) await new Promise((r) => setTimeout(r, 25));
	return liveShellCount();
}

describe("run_command and the live shell registry", () => {
	test("a running command is registered; quit ends it and the registry empties", async () => {
		const done = executor.runCommand("sleep 61", 120);
		await new Promise((r) => setTimeout(r, 400));
		expect(liveShellCount()).toBe(1);
		killLiveShells("SIGTERM");
		await done;
		expect(await registryEmpties()).toBe(0);
	});

	test("a command that finishes on its own leaves nothing registered", async () => {
		await executor.runCommand("true", 30);
		expect(await registryEmpties()).toBe(0);
	});

	test("a backgrounded command with redirected output stays registered after run_command returns, and quit ends it", async () => {
		const pidFile = join(ws, "bg.pid");
		await executor.runCommand(`sh -c 'sleep 64 >/dev/null 2>&1 & echo $! > ${pidFile}'`, 30);
		const bg = Number.parseInt(readFileSync(pidFile, "utf8").trim(), 10);
		expect(bg).toBeGreaterThan(1);
		const alive = () => {
			try {
				process.kill(bg, 0);
				return true;
			} catch {
				return false;
			}
		};
		expect(alive()).toBe(true);
		expect(liveShellCount()).toBe(1);
		killLiveShells("SIGTERM");
		const end = Date.now() + 3000;
		while (alive() && Date.now() < end) await new Promise((r) => setTimeout(r, 25));
		expect(alive()).toBe(false);
	});
});
