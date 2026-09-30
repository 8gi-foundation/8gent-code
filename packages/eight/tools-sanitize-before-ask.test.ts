/**
 * run_command: a command the shell sanitizer refuses never raises an
 * approval card (#3055).
 *
 * Before, the permission prompt ran first and the sanitizer second, so a
 * person approved `cd dir && bun test` on the card and then saw the call
 * reported "(blocked)" for chaining. The sanitizer now runs before anyone
 * is asked.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ToolExecutor } from "./tools";

type PM = {
	checkPermission: (command: string) => "allowed" | "denied" | "ask";
	requestPermission: (action: string, details: string, command?: string) => Promise<boolean>;
};

describe("run_command sanitizes before asking for approval", () => {
	let dir: string;
	let executor: ToolExecutor;
	let pm: PM;
	let origCheck: PM["checkPermission"];
	let origRequest: PM["requestPermission"];
	let asked: string[];

	beforeEach(() => {
		dir = mkdtempSync(join(tmpdir(), "sanitize-before-ask-"));
		executor = new ToolExecutor(dir, "sanitize-before-ask");
		pm = (executor as unknown as { permissionManager: PM }).permissionManager;
		origCheck = pm.checkPermission;
		origRequest = pm.requestPermission;
		asked = [];
		pm.checkPermission = () => "ask";
		pm.requestPermission = async (_a, _d, command) => {
			asked.push(command ?? "");
			return true;
		};
	});

	afterEach(() => {
		pm.checkPermission = origCheck;
		pm.requestPermission = origRequest;
		rmSync(dir, { recursive: true, force: true });
	});

	test("a chained command is blocked without an approval prompt", async () => {
		const out = await executor.runCommand("printf a > one.txt && printf b > two.txt");
		expect(out).toStartWith("[BLOCKED] Command chaining with &&");
		expect(asked).toEqual([]);
		expect(existsSync(join(dir, "one.txt"))).toBe(false);
	});

	test("a clean command still asks, and runs once approved", async () => {
		const out = await executor.runCommand("printf ok > approved.txt");
		expect(asked).toEqual(["printf ok > approved.txt"]);
		expect(out).not.toContain("[BLOCKED]");
		expect(existsSync(join(dir, "approved.txt"))).toBe(true);
	});
});
