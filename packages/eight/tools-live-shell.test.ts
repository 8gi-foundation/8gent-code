/**
 * Wiring: run_command registers its process group with live-shells, so quit
 * (killLiveShells) ends a long command the model started, and the registry is
 * empty again once the command is done.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, realpathSync, rmSync } from "node:fs";
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

describe("run_command and the live shell registry", () => {
	test("a running command is registered; quit ends it and the registry empties", async () => {
		const done = executor.runCommand("sleep 61", 120);
		await new Promise((r) => setTimeout(r, 400));
		expect(liveShellCount()).toBe(1);
		killLiveShells("SIGTERM");
		await done;
		expect(liveShellCount()).toBe(0);
	});

	test("a command that finishes on its own leaves nothing registered", async () => {
		await executor.runCommand("true", 30);
		expect(liveShellCount()).toBe(0);
	});
});
