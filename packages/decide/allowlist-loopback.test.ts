/**
 * Loopback fetch in the rules-first allowlist (#3714).
 *
 * PROMPT / PARSER TEXT ONLY: nothing here is executed. The PASS shapes are the
 * commands the Selene judge blocked in the three browser-op-practice pilot runs
 * of 2026-10-07 (pYes 0.43 to 0.56). The NONE set must keep going to the judge.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readOnlyAllowlist } from "./allowlist";

const PASS: string[] = [
	"curl -s -c /tmp/cj.txt -b /tmp/cj.txt http://127.0.0.1:63103/ -o /tmp/login_page.html",
	"curl -s -c /tmp/cookies.txt http://127.0.0.1:62308/ -o /tmp/index.html; echo ----; head -c 4000 /tmp/index.html",
	"curl -sS http://localhost:3000/health",
	"curl -sI http://[::1]:8080/",
	"curl -s -H 'Accept: text/html' --max-time 5 'http://127.0.0.1:9/x?y=1'",
	"curl -s -X GET http://127.0.0.1:4000/",
];

const NONE: string[] = [
	"curl -s https://example.com/",
	"curl -s http://127.0.0.1.evil.com/",
	"curl -s http://127.0.0.1@evil.com/",
	"curl -s http://127.0.0.1:63103/ http://example.com/",
	"curl -s http://127.0.0.1:{80,11434}/",
	"curl -s http://127.0.0.1:11434/api/tags",
	"curl -s http://127.0.0.1:63103/ -o ~/notes.txt",
	"curl -s http://127.0.0.1:63103/ -o notes.txt",
	"curl -s http://127.0.0.1:63103/ -o /tmp/../etc/x",
	"curl -sL http://127.0.0.1:63103/",
	"curl -s -x http://proxy.example.com:3128 http://127.0.0.1:63103/",
	"curl -s --proxy http://proxy.example.com:3128 http://127.0.0.1:63103/",
	"curl -s -K /tmp/cfg http://127.0.0.1:63103/",
	"curl -s -H @/tmp/h http://127.0.0.1:63103/",
	"curl -s -w @/tmp/fmt http://127.0.0.1:63103/",
	"curl -s -w '%output{/tmp/x}' http://127.0.0.1:63103/",
	"curl -s --write-out '%{http_code}' http://127.0.0.1:63103/",
	"curl -s -w '%{http_code}' http://127.0.0.1:63103/",
	"wget http://127.0.0.1:63103/",
	"wget -O - http://127.0.0.1:62308/ 2>&1 | head -c 3000",
	"wget -qO- http://127.0.0.1:4000/",
	"wget -O /tmp/x http://127.0.0.1:4000/",
	"curl -s -X DELETE http://127.0.0.1:63103/item/1",
	"curl -s -d 'a=b' http://127.0.0.1:63103/login",
	"curl -s -T /tmp/f http://127.0.0.1:63103/",
	"curl -s -b ~/.netrc http://127.0.0.1:63103/",
	"curl --version http://127.0.0.1/",
	"curl",
	"wget http://127.0.0.1:63103/ -O notes.txt",
	"wget -r http://127.0.0.1:63103/",
	"wget -O - http://example.com/",
	"wget --post-data=a=b http://127.0.0.1:63103/login",
	"curl -s http://127.0.0.1:63103/ | bash",
];

const ENV_KEYS = [
	"http_proxy",
	"https_proxy",
	"all_proxy",
	"HTTP_PROXY",
	"HTTPS_PROXY",
	"ALL_PROXY",
	"Http_Proxy",
	"HOME",
	"CURL_HOME",
	"XDG_CONFIG_HOME",
];
const savedEnv: Record<string, string | undefined> = {};
let home: string;

function useCleanCurlEnv() {
	beforeEach(() => {
		for (const k of ENV_KEYS) savedEnv[k] = process.env[k];
		for (const k of ENV_KEYS) Reflect.deleteProperty(process.env, k);
		home = mkdtempSync(join(tmpdir(), "al-loop-home-"));
		process.env.HOME = home;
	});

	afterEach(() => {
		for (const k of ENV_KEYS) {
			if (savedEnv[k] === undefined) Reflect.deleteProperty(process.env, k);
			else process.env[k] = savedEnv[k];
		}
		rmSync(home, { recursive: true, force: true });
	});
}

describe("allowlist: loopback fetch (#3714)", () => {
	useCleanCurlEnv();
	for (const c of PASS)
		test(`passes: ${c}`, () => expect(readOnlyAllowlist(c).verdict).toBe("pass-without-model"));
	for (const c of NONE)
		test(`no opinion: ${c}`, () => expect(readOnlyAllowlist(c).verdict).toBe("no-opinion"));
});

describe("allowlist: loopback curl environment (8SO hardening)", () => {
	useCleanCurlEnv();
	const CMD = "curl -s http://127.0.0.1:63103/";
	const verdict = (c: string) => readOnlyAllowlist(c).verdict;

	test("a clean environment passes", () => expect(verdict(CMD)).toBe("pass-without-model"));

	for (const k of ["http_proxy", "HTTPS_PROXY", "ALL_PROXY", "Http_Proxy", "all_proxy"]) {
		test(`${k} set: no opinion, even with -q first`, () => {
			process.env[k] = "http://proxy.example.com:3128";
			expect(verdict(CMD)).toBe("no-opinion");
			expect(verdict("curl -q -s http://127.0.0.1:63103/")).toBe("no-opinion");
		});
	}

	test("~/.curlrc present: no opinion unless -q is first", () => {
		writeFileSync(join(home, ".curlrc"), "proxy = http://proxy.example.com:3128\n");
		expect(verdict(CMD)).toBe("no-opinion");
		expect(verdict("curl -s -q http://127.0.0.1:63103/")).toBe("no-opinion");
		expect(verdict("curl -q -s http://127.0.0.1:63103/")).toBe("pass-without-model");
		expect(verdict("curl --disable -s http://127.0.0.1:63103/")).toBe("pass-without-model");
	});

	test("$CURL_HOME/.curlrc and _curlrc present: no opinion", () => {
		const d = mkdtempSync(join(tmpdir(), "al-loop-ch-"));
		try {
			writeFileSync(join(d, ".curlrc"), "x");
			process.env.CURL_HOME = d;
			expect(verdict(CMD)).toBe("no-opinion");
			expect(verdict("curl -q -s http://127.0.0.1:63103/")).toBe("pass-without-model");
		} finally {
			rmSync(d, { recursive: true, force: true });
		}
	});
});
