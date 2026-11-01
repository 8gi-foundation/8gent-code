import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	RESERVED_LOOPBACK_PORTS,
	_resetLoopbackAllowlistForTest,
	allowedLoopbackPorts,
	ignoredWorkspaceAllowlist,
	isAllowedLoopbackUrl,
	parseLoopbackEntry,
} from "./loopback-allowlist";

const dirs: string[] = [];
/** A temp dir, optionally with .8gent/allow-loopback.json. Used both as a fake HOME and a workspace. */
function dir(allow?: unknown): string {
	const d = mkdtempSync(join(tmpdir(), "lb-allow-"));
	dirs.push(d);
	if (allow !== undefined) {
		mkdirSync(join(d, ".8gent"));
		writeFileSync(join(d, ".8gent", "allow-loopback.json"), JSON.stringify(allow));
	}
	return d;
}
afterEach(() => {
	_resetLoopbackAllowlistForTest();
	for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

describe("parseLoopbackEntry", () => {
	test("loopback host with an explicit port", () => {
		expect(parseLoopbackEntry("127.0.0.1:5173")).toBe(5173);
		expect(parseLoopbackEntry("localhost:3000")).toBe(3000);
		expect(parseLoopbackEntry("[::1]:8080")).toBe(8080);
	});
	test("never a bare host, wildcard, other host or bad port", () => {
		for (const bad of [
			"127.0.0.1",
			"127.0.0.1:*",
			"127.0.0.2:80",
			"10.0.0.1:80",
			"example.com:80",
			"127.0.0.1:0",
			"127.0.0.1:70000",
			"",
			42,
		])
			expect(parseLoopbackEntry(bad)).toBeNull();
	});
	test("never a reserved service port (8SO list)", () => {
		for (const p of [
			7980, 18789, 18790, 11434, 11435, 1234, 21434, 8000, 9222, 3210, 3211, 6790, 6791,
		]) {
			expect(RESERVED_LOOPBACK_PORTS.has(p)).toBe(true);
			expect(parseLoopbackEntry(`127.0.0.1:${p}`)).toBeNull();
		}
	});
});

describe("allowedLoopbackPorts (trusted sources only)", () => {
	test("nothing listed means nothing allowed", () => {
		expect(allowedLoopbackPorts({}, dir()).size).toBe(0);
	});
	test("env list and the user file under ~/.8gent are merged; bad entries dropped", () => {
		const home = dir({ allow: ["127.0.0.1:5173", "127.0.0.1", "localhost:11434"] });
		const ports = allowedLoopbackPorts(
			{ EIGHT_BROWSER_ALLOW_LOOPBACK: "localhost:3000, 0.0.0.0:1" },
			home,
		);
		expect([...ports].sort()).toEqual([3000, 5173]);
	});
	test("a workspace file is ignored, and reported", () => {
		const home = dir();
		const ws = dir({ allow: ["127.0.0.1:5173"] });
		expect(allowedLoopbackPorts({}, home).has(5173)).toBe(false);
		expect(isAllowedLoopbackUrl("http://127.0.0.1:5173/", {}, home)).toBe(false);
		expect(ignoredWorkspaceAllowlist(ws)).toContain("Ignored");
		expect(ignoredWorkspaceAllowlist(dir())).toBeNull();
		expect(ignoredWorkspaceAllowlist(undefined)).toBeNull();
	});
	test("frozen at first read: a user file rewritten mid-session does not change the list", () => {
		const home = dir({ allow: ["127.0.0.1:5173"] });
		expect(allowedLoopbackPorts({}, home).has(5173)).toBe(true);
		writeFileSync(
			join(home, ".8gent", "allow-loopback.json"),
			JSON.stringify({ allow: ["127.0.0.1:4000"] }),
		);
		expect(allowedLoopbackPorts({}, home).has(4000)).toBe(false);
		expect(allowedLoopbackPorts({}, home).has(5173)).toBe(true);
	});
	test("frozen at first read: a user file created mid-session adds nothing", () => {
		const home = dir();
		expect(allowedLoopbackPorts({}, home).size).toBe(0);
		mkdirSync(join(home, ".8gent"));
		writeFileSync(
			join(home, ".8gent", "allow-loopback.json"),
			JSON.stringify({ allow: ["127.0.0.1:4000"] }),
		);
		expect(allowedLoopbackPorts({}, home).size).toBe(0);
	});
	test("a malformed file is an empty list", () => {
		const home = dir();
		mkdirSync(join(home, ".8gent"));
		writeFileSync(join(home, ".8gent", "allow-loopback.json"), "{not json");
		expect(allowedLoopbackPorts({}, home).size).toBe(0);
	});
});

describe("isAllowedLoopbackUrl", () => {
	test("only http(s) to an allowed loopback port, any loopback spelling", () => {
		const env = { EIGHT_BROWSER_ALLOW_LOOPBACK: "127.0.0.1:5173" };
		const home = dir();
		expect(isAllowedLoopbackUrl("http://127.0.0.1:5173/login", env, home)).toBe(true);
		expect(isAllowedLoopbackUrl("http://localhost:5173/", env, home)).toBe(true);
		expect(isAllowedLoopbackUrl("http://127.0.0.1:5174/", env, home)).toBe(false);
		expect(isAllowedLoopbackUrl("http://127.0.0.1/", env, home)).toBe(false);
		expect(isAllowedLoopbackUrl("http://u:p@127.0.0.1:5173/", env, home)).toBe(false);
		expect(isAllowedLoopbackUrl("file:///etc/passwd", env, home)).toBe(false);
		expect(isAllowedLoopbackUrl("http://169.254.169.254:5173/", env, home)).toBe(false);
		expect(isAllowedLoopbackUrl("not a url", env, home)).toBe(false);
	});
});
