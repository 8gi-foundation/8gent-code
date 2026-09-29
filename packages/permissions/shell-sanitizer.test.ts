/**
 * Shared run_command sanitizer (packages/permissions/shell-sanitizer.ts).
 *
 * Unit: a single unquoted `&` separating commands is blocked on every
 * platform; quoted, escaped and redirection forms stay allowed; the other
 * rules (&&, ||, ;, $(), backticks) are unchanged.
 *
 * Integration: both real entry points - ToolExecutor.run_command and the AI
 * SDK agentTools.run_command - refuse a chained command before any spawn
 * (neither sentinel file is created) and still run a quoted `&`.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { agentTools, setToolContext } from "../ai/tools";
import { ToolExecutor } from "../eight/tools";
import { hasUnquotedAmpersand, sanitizeShellCommand } from "./shell-sanitizer";

const AMP_REASON =
	"Command chaining or background execution with & is not allowed. Use separate run_command calls instead";

describe("sanitizeShellCommand: single & (POSIX and Windows)", () => {
	const blocked = [
		"sleep 100 & del x",
		"a & b",
		"curl x & rm -rf y",
		"sleep 100 &",
		"sleep 100 & ",
		"a&b",
		'echo "ok" & rm y',
		"echo 'ok' & rm y",
		"cmd 2>&1 & rm y",
	];

	for (const platform of ["linux", "darwin", "win32"] as const) {
		for (const cmd of blocked) {
			test(`blocks \`${cmd}\` on ${platform}`, () => {
				const r = sanitizeShellCommand(cmd, platform);
				expect(r.safe).toBe(false);
				expect(r.reason).toBe(AMP_REASON);
			});
		}
	}

	const allowedEverywhere = [
		'echo "a&b"',
		"cmd 2>&1",
		"cmd >&2",
		"cmd 1<&0",
		'curl "https://x?a=1&b=2"',
	];
	for (const platform of ["linux", "darwin", "win32"] as const) {
		for (const cmd of allowedEverywhere) {
			test(`allows \`${cmd}\` on ${platform}`, () => {
				expect(sanitizeShellCommand(cmd, platform)).toEqual({ safe: true });
			});
		}
	}

	// POSIX-only quoting and escaping forms.
	const allowedPosix = [
		"curl 'https://x?a=1&b=2'",
		"echo a\\&b",
		"cmd &>out.log",
		"cmd &>>out.log",
		'echo "a \\" & b"',
	];
	for (const platform of ["linux", "darwin"] as const) {
		for (const cmd of allowedPosix) {
			test(`allows \`${cmd}\` on ${platform}`, () => {
				expect(sanitizeShellCommand(cmd, platform)).toEqual({ safe: true });
			});
		}
	}

	// cmd.exe does not treat single quotes as quoting or \ as an escape, so the
	// POSIX-safe forms above really do chain there. Its escape is ^.
	test("win32: single quotes do not protect &", () => {
		expect(sanitizeShellCommand("curl 'https://x?a=1&b=2'", "win32").safe).toBe(false);
	});
	test("win32: backslash does not escape &", () => {
		expect(sanitizeShellCommand("echo a\\&b", "win32").safe).toBe(false);
	});
	test("win32: &> is a separator, not a redirect", () => {
		expect(sanitizeShellCommand("cmd &>out.log", "win32").safe).toBe(false);
	});
	test("win32: caret-escaped ^& is allowed", () => {
		expect(sanitizeShellCommand("echo a^&b", "win32")).toEqual({ safe: true });
	});

	test("default platform is the host", () => {
		expect(sanitizeShellCommand("sleep 100 & del x").safe).toBe(false);
		expect(sanitizeShellCommand('echo "a&b"').safe).toBe(true);
	});

	test("hasUnquotedAmpersand leaves && to its own rule", () => {
		expect(hasUnquotedAmpersand("a && b", "linux")).toBe(false);
	});
});

describe("sanitizeShellCommand: other rules unchanged", () => {
	test("&& stays blocked with its own message", () => {
		for (const platform of ["linux", "win32"] as const) {
			const r = sanitizeShellCommand("a && b", platform);
			expect(r.safe).toBe(false);
			expect(r.reason).toBe(
				"Command chaining with && is not allowed. Use separate run_command calls instead",
			);
		}
	});
	test("&& inside quotes is still blocked (rule is unchanged)", () => {
		expect(sanitizeShellCommand('echo "a&&b"', "linux").safe).toBe(false);
	});
	test("|| ; $() and backticks still blocked", () => {
		expect(sanitizeShellCommand("a || b").reason).toContain("||");
		expect(sanitizeShellCommand("a; b").reason).toContain("Semicolon");
		expect(sanitizeShellCommand("echo $(id)").reason).toContain("$(...)");
		expect(sanitizeShellCommand("echo `id`").reason).toContain("backticks");
	});
	test("pipes and plain redirects still allowed", () => {
		expect(sanitizeShellCommand("ls | grep x > out.txt").safe).toBe(true);
	});
});

describe("run_command entry points route through the shared sanitizer", () => {
	let dir: string;
	let executor: ToolExecutor;

	beforeEach(() => {
		dir = mkdtempSync(join(tmpdir(), "amp-gate-"));
		executor = new ToolExecutor(dir, "amp-test");
		setToolContext({ workingDirectory: dir });
	});
	afterEach(() => {
		rmSync(dir, { recursive: true, force: true });
	});

	const callSdk = (input: Record<string, unknown>) =>
		(
			agentTools.run_command as unknown as {
				execute: (i: unknown, o: unknown) => Promise<string>;
			}
		).execute(input, { toolCallId: "amp", messages: [] });

	test("ToolExecutor run_command: chained command is blocked before spawn", async () => {
		const out = await executor.execute("run_command", {
			command: `touch ${join(dir, "amp-a")} & touch ${join(dir, "amp-b")}`,
		});
		expect(out).toStartWith("[BLOCKED]");
		expect(out).toContain(AMP_REASON);
		await Bun.sleep(200);
		expect(existsSync(join(dir, "amp-a"))).toBe(false);
		expect(existsSync(join(dir, "amp-b"))).toBe(false);
	});

	test("AI SDK run_command: chained command is blocked before spawn", async () => {
		const out = await callSdk({
			command: `touch ${join(dir, "sdk-a")} & touch ${join(dir, "sdk-b")}`,
		});
		expect(out).toStartWith("[BLOCKED]");
		expect(out).toContain(AMP_REASON);
		await Bun.sleep(200);
		expect(existsSync(join(dir, "sdk-a"))).toBe(false);
		expect(existsSync(join(dir, "sdk-b"))).toBe(false);
	});

	test("AI SDK run_command: && is now blocked here too", async () => {
		const out = await callSdk({ command: `touch ${join(dir, "sdk-c")} && echo x` });
		expect(out).toStartWith("[BLOCKED]");
		expect(existsSync(join(dir, "sdk-c"))).toBe(false);
	});

	test("both paths still run a quoted &", async () => {
		const a = await executor.execute("run_command", { command: 'echo "amp&ok"' });
		expect(a).toContain("amp&ok");
		const b = await callSdk({ command: 'echo "amp&ok"' });
		expect(b).toContain("amp&ok");
	});
});
