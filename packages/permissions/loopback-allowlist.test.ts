import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	_resetLoopbackAllowlistForTest,
	allowedLoopbackPorts,
	isAllowedLoopbackUrl,
	parseLoopbackEntry,
} from "./loopback-allowlist";

const dirs: string[] = [];
function ws(allow?: unknown): string {
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
	test("never a bare host, wildcard, other host or reserved service port", () => {
		for (const bad of [
			"127.0.0.1",
			"127.0.0.1:*",
			"127.0.0.2:80",
			"10.0.0.1:80",
			"example.com:80",
			"127.0.0.1:0",
			"127.0.0.1:70000",
			"127.0.0.1:7980",
			"localhost:11434",
			"127.0.0.1:18789",
			"127.0.0.1:1234",
			"",
			42,
		])
			expect(parseLoopbackEntry(bad)).toBeNull();
	});
});

describe("allowedLoopbackPorts", () => {
	test("nothing listed means nothing allowed", () => {
		expect(allowedLoopbackPorts(ws(), {}).size).toBe(0);
	});
	test("env and workspace file are merged; bad entries dropped", () => {
		const d = ws({ allow: ["127.0.0.1:5173", "127.0.0.1", "localhost:11434"] });
		expect(
			[
				...allowedLoopbackPorts(d, { EIGHT_BROWSER_ALLOW_LOOPBACK: "localhost:3000, 0.0.0.0:1" }),
			].sort(),
		).toEqual([3000, 5173]);
	});
	test("frozen at first read: a file written later does not widen the list", () => {
		const d = ws({ allow: ["127.0.0.1:5173"] });
		expect(allowedLoopbackPorts(d, {}).has(5173)).toBe(true);
		writeFileSync(
			join(d, ".8gent", "allow-loopback.json"),
			JSON.stringify({ allow: ["127.0.0.1:4000"] }),
		);
		expect(allowedLoopbackPorts(d, {}).has(4000)).toBe(false);
	});
	test("a malformed file is an empty list", () => {
		const d = ws();
		mkdirSync(join(d, ".8gent"));
		writeFileSync(join(d, ".8gent", "allow-loopback.json"), "{not json");
		expect(allowedLoopbackPorts(d, {}).size).toBe(0);
	});
});

describe("isAllowedLoopbackUrl", () => {
	test("only http(s) to an allowed loopback port, any loopback spelling", () => {
		const env = { EIGHT_BROWSER_ALLOW_LOOPBACK: "127.0.0.1:5173" };
		const d = ws();
		expect(isAllowedLoopbackUrl("http://127.0.0.1:5173/login", d, env)).toBe(true);
		expect(isAllowedLoopbackUrl("http://localhost:5173/", d, env)).toBe(true);
		expect(isAllowedLoopbackUrl("http://127.0.0.1:5174/", d, env)).toBe(false);
		expect(isAllowedLoopbackUrl("http://127.0.0.1/", d, env)).toBe(false);
		expect(isAllowedLoopbackUrl("http://u:p@127.0.0.1:5173/", d, env)).toBe(false);
		expect(isAllowedLoopbackUrl("file:///etc/passwd", d, env)).toBe(false);
		expect(isAllowedLoopbackUrl("http://169.254.169.254:5173/", d, env)).toBe(false);
		expect(isAllowedLoopbackUrl("not a url", d, env)).toBe(false);
	});
});
