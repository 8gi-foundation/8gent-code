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
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { REFUSAL_LEAD, REFUSAL_NOTE, ToolExecutor } from "./tools";

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
		expect(out).toContain("Command chaining with &&");
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

/**
 * A chained command the sanitizer refuses names, in the same refusal, a piece
 * System One's loopback lane would refuse on its own (#4072). The browser-op
 * pilot sent `curl -sL ...; cat ...`, was told only to split it, resent the
 * curl with -L and got a second block. The hint is the lane's own text, and
 * only in the mode where the lane runs.
 */
describe("run_command: a chained curl -L is told about -L in the chaining refusal", () => {
	const PILOT_CHAIN =
		'curl -sL -b .tmp/cookies.txt http://127.0.0.1:55383/settings -D .tmp/settings.headers -o .tmp/settings.html; echo "headers:"; cat .tmp/settings.headers';
	const ENV_KEYS = [
		"EIGHT_SYSTEM_ONE",
		"EIGHT_S1_ALLOWLIST",
		"HOME",
		"CURL_HOME",
		"XDG_CONFIG_HOME",
		"http_proxy",
		"https_proxy",
		"all_proxy",
		"HTTP_PROXY",
		"HTTPS_PROXY",
		"ALL_PROXY",
	];
	const saved: Record<string, string | undefined> = {};
	let dir: string;
	let executor: ToolExecutor;
	let pm: PM;
	let origCheck: PM["checkPermission"];
	let origRequest: PM["requestPermission"];
	let asked: string[];

	beforeEach(() => {
		for (const k of ENV_KEYS) saved[k] = process.env[k];
		// Default mode (the lane runs), no proxy, a clean fake home with no curlrc.
		for (const k of ENV_KEYS) Reflect.deleteProperty(process.env, k);
		process.env.HOME = mkdtempSync(join(tmpdir(), "chained-curl-home-"));
		dir = mkdtempSync(join(tmpdir(), "chained-curl-"));
		mkdirSync(join(dir, ".tmp"));
		writeFileSync(join(dir, ".tmp", "cookies.txt"), "# Netscape HTTP Cookie File\n");
		executor = new ToolExecutor(dir, "chained-curl");
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
		rmSync(process.env.HOME ?? "", { recursive: true, force: true });
		for (const k of ENV_KEYS) {
			if (saved[k] === undefined) Reflect.deleteProperty(process.env, k);
			else process.env[k] = saved[k];
		}
	});

	test("the pilot's chain: chaining refusal carries the lane's -L refusal, nothing runs or asks", async () => {
		const out = await executor.runCommand(PILOT_CHAIN);
		expect(out).toContain("Semicolon command chaining is not allowed");
		expect(out).toContain("One part would be refused on its own too.");
		expect(out).toContain("Drop -L");
		expect(out).toContain("Location header");
		expect(out).toEndWith(`Command: ${PILOT_CHAIN}`);
		expect(asked).toEqual([]);
		expect(existsSync(join(dir, ".tmp", "settings.html"))).toBe(false);
	});

	test("the same chain without -L: the plain chaining refusal, no -L hint", async () => {
		const out = await executor.runCommand(PILOT_CHAIN.replace("curl -sL", "curl -s"));
		expect(out).toContain("Semicolon command chaining is not allowed");
		expect(out).not.toContain("Drop -L");
		expect(out).not.toContain("refused on its own");
	});

	test("a chain with no curl in it: the plain chaining refusal", async () => {
		const out = await executor.runCommand("printf a > one.txt; printf b > two.txt");
		expect(out).toBe(
			`[BLOCKED] Send each command as its own run_command call. Semicolon command chaining is not allowed. ${REFUSAL_NOTE} Command: printf a > one.txt; printf b > two.txt`,
		);
	});

	test("System One off: no hint, since nothing would refuse the piece", async () => {
		process.env.EIGHT_SYSTEM_ONE = "0";
		const out = await executor.runCommand(PILOT_CHAIN);
		expect(out).toContain("Semicolon command chaining is not allowed");
		expect(out).not.toContain("Drop -L");
	});

	test("strict mode: no hint, the judge decides there, not the lane", async () => {
		process.env.EIGHT_SYSTEM_ONE = "1";
		const out = await executor.runCommand(PILOT_CHAIN);
		expect(out).toContain("Semicolon command chaining is not allowed");
		expect(out).not.toContain("Drop -L");
	});
});
