/**
 * #3941: System One must not stop a plain curl to the scenario's own loopback
 * server, and must not pass anything that reaches off the box or outside the
 * workspace. The judge here says "dangerous" to everything, so any command
 * that reaches it is blocked; a negative must never be the allowlist.
 */

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { cleanupTempDirs, tempDir } from "../../tests/temp-dirs";
import { createDecider } from "../decide/index";
import type { DecideBackend, SystemOneRequest, SystemOneResponse } from "../decide/types";
import { CURL_L_REFUSAL, CURL_OUT_NAME_REFUSAL, curlToLoopback } from "./s1-curl-loopback";
import {
	SYSTEM_ONE_ALLOWLIST_FLAG,
	SYSTEM_ONE_FLAG,
	_resetSystemOne,
	_setSystemOneOverridesForTests,
	systemOneGate,
} from "./system-one-gate";

afterAll(cleanupTempDirs);

class AlwaysDangerous implements DecideBackend {
	readonly name = "stub";
	readonly model = "always-dangerous";
	asks = 0;
	async ask(request: SystemOneRequest): Promise<SystemOneResponse> {
		this.asks++;
		return {
			answers: [
				{
					id: request.questions[0].id,
					kind: "noul",
					probabilities: { yes: 0.99 },
					confidence: 0.99,
				},
			],
			backend: this.name,
			model: this.model,
			latencyMs: 0,
		};
	}
}

// The exact command from the issue (port is the stub's). It has -L, which this lane refuses (8SO).
// ISSUE_NO_L is the same command with the redirect followed by a second loopback request.
const ISSUE_CMD =
	"curl -s -c .tmp/cookies.txt -b .tmp/cookies.txt -L -D .tmp/headers.txt http://127.0.0.1:41873/login";

const ISSUE_NO_L =
	"curl -s -c .tmp/cookies.txt -b .tmp/cookies.txt -D .tmp/headers.txt http://127.0.0.1:41873/login";

let ws: string;
let outside: string;
let judge: AlwaysDangerous;
const PROXY_VARS = [
	"http_proxy",
	"https_proxy",
	"all_proxy",
	"HTTP_PROXY",
	"HTTPS_PROXY",
	"ALL_PROXY",
];
const saved: Record<string, string | undefined> = {};
const KEYS = [
	SYSTEM_ONE_FLAG,
	SYSTEM_ONE_ALLOWLIST_FLAG,
	"EIGHT_HEADLESS",
	"EIGHT_WORKSPACE_ROOT",
	"HOME",
	"CURL_HOME",
	"XDG_CONFIG_HOME",
	...PROXY_VARS,
];

beforeAll(() => {
	for (const k of KEYS) saved[k] = process.env[k];
	Reflect.deleteProperty(process.env, "EIGHT_WORKSPACE_ROOT");
	Reflect.deleteProperty(process.env, SYSTEM_ONE_ALLOWLIST_FLAG);
	Reflect.deleteProperty(process.env, SYSTEM_ONE_FLAG);
	process.env.EIGHT_HEADLESS = "1";
});
afterAll(() => {
	for (const k of KEYS) {
		if (saved[k] === undefined) Reflect.deleteProperty(process.env, k);
		else process.env[k] = saved[k];
	}
	_resetSystemOne();
});

function put(rel: string, body = "x", root = ws) {
	const abs = join(root, rel);
	mkdirSync(join(abs, ".."), { recursive: true });
	writeFileSync(abs, body);
}

beforeEach(() => {
	ws = tempDir("s1-curl-ws-");
	outside = tempDir("s1-curl-out-");
	// A clean fake home: no curlrc, so the tests do not depend on the machine.
	process.env.HOME = tempDir("s1-curl-home-");
	Reflect.deleteProperty(process.env, "CURL_HOME");
	Reflect.deleteProperty(process.env, "XDG_CONFIG_HOME");
	for (const k of PROXY_VARS) Reflect.deleteProperty(process.env, k);
	put("data.json", "{}");
	put(".tmp/seed.txt");
	put(".git/config", "[core]");
	put(".env", "SECRET=1");
	put("src/app.ts", "export {};");
	put("packages/permissions/gate.ts", "export {};");
	writeFileSync(join(outside, "secret.txt"), "s");
	symlinkSync(outside, join(ws, "escape"));
	symlinkSync(join(outside, "secret.txt"), join(ws, "link.txt"));
	judge = new AlwaysDangerous();
	_setSystemOneOverridesForTests({
		createDecider: () => createDecider({ backend: judge, cacheSize: 0 }),
		askHuman: async () => null,
		calibrationDir: tempDir("s1-curl-nocal-"),
	});
});

afterEach(() => {
	rmSync(ws, { recursive: true, force: true });
	rmSync(outside, { recursive: true, force: true });
	Reflect.deleteProperty(process.env, SYSTEM_ONE_ALLOWLIST_FLAG);
	Reflect.deleteProperty(process.env, SYSTEM_ONE_FLAG);
});

const ok = (c: string) => curlToLoopback(c, ws).ok;

describe("curlToLoopback allows", () => {
	test("the issue's command without -L (follow a 302 with a second loopback request)", () => {
		expect(ok(ISSUE_NO_L)).toBe(true);
	});
	test("loopback hosts, default and explicit ports, http and https", () => {
		for (const u of [
			"http://127.0.0.1:8080/",
			"http://127.0.0.1/x",
			"'http://localhost:3000/a/b?x=1'",
			"https://localhost/",
			"'http://[::1]:9000/p'",
			"http://localhost",
		]) {
			expect(ok(`curl -s ${u}`), u).toBe(true);
		}
	});
	test("common safe shapes", () => {
		for (const c of [
			"curl -s -o /dev/null -w '%{http_code}' http://127.0.0.1:8080/",
			"curl -sS -f -i http://127.0.0.1:8080/",
			"curl -sSo .tmp/out.html http://127.0.0.1:8080/",
			"curl -s -X POST -d 'user=a&pw=b' -c .tmp/jar.txt http://127.0.0.1:8080/login",
			'curl -s -H "Accept: application/json" http://localhost:8080/api',
			"curl -s -d @data.json http://127.0.0.1:8080/api",
			"curl -s --data-binary @.tmp/seed.txt http://127.0.0.1:8080/api",
			"curl -s -F file=@data.json http://127.0.0.1:8080/up",
			"curl -s -T data.json http://127.0.0.1:8080/up",
			"curl -s -b 'sid=abc' http://127.0.0.1:8080/",
			"curl -s -b .tmp/cookies.txt -D - http://127.0.0.1:8080/",
			"curl -s -m 5 --max-redirs 0 http://127.0.0.1:8080/",
			"curl -s -o .tmp/a.txt http://127.0.0.1:8080/ http://localhost:8081/",
			"curl -q -s http://127.0.0.1:8080/",
		]) {
			expect(ok(c), c).toBe(true);
		}
	});
	test("an absolute path inside the workspace", () => {
		const cmd = `curl -s -c ${realpathSync.native(ws).replaceAll("\\", "/")}/.tmp/jar.txt http://127.0.0.1:8080/`;
		expect(ok(cmd), `${cmd} (cwd ${ws})`).toBe(true);
	});
});

describe("curlToLoopback refuses", () => {
	test("hosts that are not loopback", () => {
		for (const u of [
			"http://example.com/",
			"https://api.github.com/",
			"http://127.0.0.1.evil.com/",
			"http://localhost.evil.com/",
			"http://evil.com@127.0.0.1/",
			"http://127.0.0.1@evil.com/",
			"http://127.0.0.2:80/",
			"http://0.0.0.0/",
			"'http://[::2]/'",
			"127.0.0.1:8080/",
			"localhost",
			"file:///etc/passwd",
			"ftp://127.0.0.1/",
			"gopher://127.0.0.1/",
			"HTTP://127.0.0.1:0/",
			"http://127.0.0.1:70000/",
			"http://127.0.0.1:8080/{a,b}",
			"'http://127.0.0.1:8080/[1-9]'",
			"http://127.0.0.1:8080:9/",
		]) {
			expect(ok(`curl -s ${u}`), u).toBe(false);
		}
		expect(ok("curl -s http://127.0.0.1:8080/ http://example.com/")).toBe(false);
		expect(ok("curl -s --url http://example.com/")).toBe(false);
		expect(ok("curl -s")).toBe(false);
	});
	test("file flags that leave the workspace", () => {
		const bad = [
			"-o /tmp/x",
			"-o ../x",
			"-o escape/x",
			"-o link.txt",
			"-c /etc/jar",
			"-D ~/x",
			"-b /etc/passwd",
			"-T /etc/passwd",
			"-T -",
			"-d @/etc/passwd",
			"-d @-",
			"--data-binary @../x",
			"--data-ascii @/etc/hosts",
			"--data-urlencode @/etc/hosts",
			"--data-urlencode q@/etc/hosts",
			"-F f=@/etc/passwd",
			"-F f=@../x",
			"-F f=@data.json,/etc/passwd",
			"-F f=</etc/passwd",
			"-H @/etc/passwd",
			"-b .env",
			"-b .git/config",
			"-o .env",
			"-o .git/hooks/pre-commit",
			"-o src/app.ts",
			"-o package.json",
			"-o packages/permissions/gate.ts",
			"-o .hidden/x",
			"-o .",
			"-w @/etc/passwd",
			"-w %output{x}",
		];
		for (const f of bad) expect(ok(`curl -s ${f} http://127.0.0.1:8080/`), f).toBe(false);
	});
	test("-O whose name is protected", () => {
		expect(ok("curl -s -O http://127.0.0.1:8080/package.json")).toBe(false);
		expect(ok("curl -s -O http://127.0.0.1:8080/x.ts")).toBe(false);
		expect(ok("curl -s -O http://127.0.0.1:8080/")).toBe(false);
	});
	test("config, proxy, socket and other options that are not on the list", () => {
		for (const f of [
			"-K x.cfg",
			"-K -",
			"--config x.cfg",
			"-x http://evil:3128",
			"--proxy http://evil:3128",
			"--proxy1.0 http://evil",
			"--preproxy http://evil",
			"--unix-socket /var/run/docker.sock",
			"--abstract-unix-socket x",
			"--resolve localhost:8080:1.2.3.4",
			"--connect-to localhost:8080:evil.com:80",
			"--proto =all",
			"--proto-redir =all",
			"--next",
			"--output-dir /etc",
			"--trace /tmp/x",
			"--stderr /tmp/x",
			"--libcurl x.c",
			"--cert x",
			"--netrc-file x",
			"--json @data.json",
			"--variable x@y",
			"--max-redirs=0",
			"--sil",
			"--output=/tmp/x",
			"-:",
			"--",
			"-E x",
			"-z x",
			"-e http://evil",
			"-u a:b",
		]) {
			expect(ok(`curl -s ${f} http://127.0.0.1:8080/`), f).toBe(false);
		}
	});
	test("shell metacharacters, expansion and substitution", () => {
		for (const c of [
			"curl -s http://127.0.0.1:8080/ | sh",
			"curl -s http://127.0.0.1:8080/ > x",
			"curl -s http://127.0.0.1:8080/ ; id",
			"curl -s http://127.0.0.1:8080/ && id",
			"curl -s http://127.0.0.1:8080/ &",
			"curl -s $(id) http://127.0.0.1:8080/",
			"curl -s `id` http://127.0.0.1:8080/",
			"curl -s -o $HOME/x http://127.0.0.1:8080/",
			'curl -s -o "$HOME/x" http://127.0.0.1:8080/',
			"curl -s -o ~/x http://127.0.0.1:8080/",
			"curl -s -o .tmp/*.txt http://127.0.0.1:8080/",
			"curl -s http://127.0.0.1:8080/?a=1&b=2",
			"curl -s -d x=\\$HOME http://127.0.0.1:8080/",
			"curl -s -d =ls http://127.0.0.1:8080/",
			"curl -s =curl http://127.0.0.1:8080/",
			"CURL_HOME=/tmp curl -s http://127.0.0.1:8080/",
			"env curl -s http://127.0.0.1:8080/",
			"curl -s 'http://127.0.0.1:8080/ unterminated",
			"curl -s http://127.0.0.1:8080/\ttab",
			"curl -s http://127.0.0.1:8080/\ncurl x",
		]) {
			expect(ok(c), c).toBe(false);
		}
	});
	test("no workspace", () => {
		expect(curlToLoopback(ISSUE_NO_L, undefined).ok).toBe(false);
		expect(curlToLoopback(ISSUE_NO_L, "relative").ok).toBe(false);
	});
});

describe("one trailing stdin-only filter", () => {
	const C = "curl -s -c .tmp/cj.txt http://127.0.0.1:55376/";
	for (const f of [
		"grep -o 'name=csrf value=[a-f0-9]*'",
		"grep -oE 'csrf value=[a-f0-9]+'",
		"grep -i Weekly",
		"head -50",
		"head -n 5",
		"tail -3",
		"wc -l",
	]) {
		test(`allows | ${f}`, () => expect(ok(`${C} | ${f}`)).toBe(true));
	}
	for (const f of [
		"grep -f patterns.txt",
		"grep -r csrf .",
		"grep csrf .env",
		"grep -e x -e y",
		"grep -- -x",
		"sh",
		"bash -c id",
		"tee out.txt",
		"xargs curl",
		"head -50 /etc/passwd",
		"sed -n 1p",
		"grep x | grep y",
		"grep x > out",
		"grep x; ls",
	]) {
		test(`refuses | ${f}`, () => expect(ok(`${C} | ${f}`)).toBe(false));
	}
	test("refuses || and |& and a pipe inside the curl part to a bad URL", () => {
		expect(ok(`${C} || true`)).toBe(false);
		expect(ok(`${C} |& grep x`)).toBe(false);
		expect(ok("curl -s http://example.com/ | grep x")).toBe(false);
		expect(ok("curl -s -L http://127.0.0.1:55376/ | grep x")).toBe(false);
	});
	for (const k of ["GREP_OPTIONS", "GREP_COLOR", "GREP_COLORS"]) {
		test(`${k} set: a piped command is refused, a bare curl still passes`, () => {
			process.env[k] = "--color=always";
			try {
				expect(ok(`${C} | grep -o csrf`)).toBe(false);
				expect(ok(`${C} | head -5`)).toBe(false);
				expect(ok(C)).toBe(true);
			} finally {
				Reflect.deleteProperty(process.env, k);
			}
		});
	}
	test("a quoted pipe is not a pipe", () => {
		expect(ok("curl -s -H 'X: a|b' http://127.0.0.1:55376/")).toBe(true);
	});
	test("the pilot's command passes the gate without asking the judge", async () => {
		const r = await systemOneGate(`${C} | grep -o 'name=csrf value=[a-f0-9]*'`, process.env, ws);
		expect(r.run).toBe(true);
		expect(r.guard?.backend).toBe("allowlist");
		expect(judge.asks).toBe(0);
	});
});

describe("-L is refused (8SO: the redirect host cannot be pinned)", () => {
	test("the issue's exact command, with -L, goes to the judge", () => {
		expect(ok(ISSUE_CMD)).toBe(false);
	});
	test("every spelling of -L is refused", () => {
		for (const c of [
			"curl -sL http://127.0.0.1:8080/",
			"curl -s -L http://127.0.0.1:8080/",
			"curl -s --location http://127.0.0.1:8080/",
			"curl -s --location-trusted http://127.0.0.1:8080/",
			"curl -sL -b .tmp/c.txt -c .tmp/c.txt http://127.0.0.1:8080/",
			"curl -sL -d x=1 http://127.0.0.1:8080/",
		]) {
			expect(ok(c), c).toBe(false);
		}
	});
});

describe("-F options and writes (8SO)", () => {
	test("-F with headers= or any option other than type= and filename= is refused", () => {
		const outsideFile = "/etc/ho" + "sts";
		for (const f of [
			`'f=a;headers=@${outsideFile}'`,
			"'f=a;headers=<data.json'",
			"'f=a;headers=@data.json'",
			`'f=@data.json;headers=@${outsideFile}'`,
			"'f=@data.json;headers=<../x'",
			"'f=@data.json;encoder=base64'",
			"'f=@data.json;type=text/plain;headers=@data.json'",
			"'f=a;HEADERS=@data.json'",
		]) {
			expect(ok(`curl -s -F ${f} http://127.0.0.1:8080/`), f).toBe(false);
			expect(ok(`curl -s --form ${f} http://127.0.0.1:8080/`), f).toBe(false);
		}
		expect(
			ok("curl -s -F 'f=@data.json;type=text/plain;filename=x.txt' http://127.0.0.1:8080/"),
		).toBe(true);
	});
	test("outputs are allowed only under .tmp/", () => {
		for (const f of [
			"-o out.txt",
			"-o data.json",
			"-c cookies.txt",
			"-D headers.txt",
			"-o docs/x.txt",
			"-o .tmp",
			"-o .tmp/",
			"-o .tmp/node_modules/x",
			"-o .tmp/t.py",
			"-o .tmp/Makefile",
			"-o .tmp/CLAUDE.md",
		]) {
			expect(ok(`curl -s ${f} http://127.0.0.1:8080/`), f).toBe(false);
		}
		for (const f of [
			"-o .tmp/out.txt",
			"-c .tmp/a/b.txt",
			"-D .tmp/h.txt",
			"-o /dev/null",
			"-D -",
			"-o -",
		]) {
			expect(ok(`curl -s ${f} http://127.0.0.1:8080/`), f).toBe(true);
		}
	});
	test("-O and --remote-name are refused", () => {
		for (const c of [
			"curl -s -O http://127.0.0.1:8080/a.txt",
			"curl -s --remote-name http://127.0.0.1:8080/a.txt",
			"curl -sO http://127.0.0.1:8080/a.txt",
		]) {
			expect(ok(c), c).toBe(false);
		}
	});
});

describe("symlinks under .tmp (8SO)", () => {
	test("a dangling symlink as the final component is refused", () => {
		put(".tmp/keep.txt");
		symlinkSync("../src/pwn.txt", join(ws, ".tmp", "linkfile"));
		expect(ok("curl -s -o .tmp/linkfile http://127.0.0.1:8080/")).toBe(false);
		expect(ok("curl -s -c .tmp/linkfile http://127.0.0.1:8080/")).toBe(false);
		expect(ok("curl -s -D .tmp/linkfile http://127.0.0.1:8080/")).toBe(false);
		expect(ok("curl -s -o .tmp/fresh.txt http://127.0.0.1:8080/")).toBe(true);
	});
	test("a symlinked directory below .tmp is refused", () => {
		symlinkSync("../src", join(ws, ".tmp", "sub"));
		expect(ok("curl -s -o .tmp/sub/a.txt http://127.0.0.1:8080/")).toBe(false);
	});
	test(".tmp itself a symlink refuses every write", () => {
		rmSync(join(ws, ".tmp"), { recursive: true, force: true });
		symlinkSync("src", join(ws, ".tmp"));
		expect(ok("curl -s -o .tmp/a.txt http://127.0.0.1:8080/")).toBe(false);
		expect(ok("curl -s -c .tmp/j.txt http://127.0.0.1:8080/")).toBe(false);
		expect(ok("curl -s -D .tmp/h.txt http://127.0.0.1:8080/")).toBe(false);
		expect(ok("curl -s -o /dev/null http://127.0.0.1:8080/")).toBe(true);
	});
	test(".tmp that is a file refuses writes", () => {
		rmSync(join(ws, ".tmp"), { recursive: true, force: true });
		writeFileSync(join(ws, ".tmp"), "x");
		expect(ok("curl -s -o .tmp/a.txt http://127.0.0.1:8080/")).toBe(false);
	});
	test("a .. after a link is refused", () => {
		symlinkSync("../src", join(ws, ".tmp", "sub"));
		expect(ok("curl -s -o .tmp/sub/../a.txt http://127.0.0.1:8080/")).toBe(false);
	});
});

describe("curl environment", () => {
	test("a curlrc in the home directory refuses unless -q is first", () => {
		put(".curlrc", "proxy=http://evil:1", process.env.HOME as string);
		expect(ok(ISSUE_NO_L)).toBe(false);
		expect(ok("curl -q -s http://127.0.0.1:8080/")).toBe(true);
		expect(ok("curl --disable -s http://127.0.0.1:8080/")).toBe(true);
		expect(ok("curl -s -q http://127.0.0.1:8080/")).toBe(false);
	});
	test("curlrc under CURL_HOME and XDG_CONFIG_HOME", () => {
		const d = tempDir("s1-curl-ch-");
		put("_curlrc", "x", d);
		process.env.CURL_HOME = d;
		expect(ok(ISSUE_NO_L)).toBe(false);
		Reflect.deleteProperty(process.env, "CURL_HOME");
		const x = tempDir("s1-curl-xdg-");
		put(".curlrc", "x", x);
		process.env.XDG_CONFIG_HOME = x;
		expect(ok(ISSUE_NO_L)).toBe(false);
	});
	test("a proxy variable in the environment refuses", () => {
		process.env.http_proxy = "http://evil:3128";
		expect(ok(ISSUE_NO_L)).toBe(false);
		Reflect.deleteProperty(process.env, "http_proxy");
		process.env.ALL_PROXY = "socks5://evil:1080";
		expect(ok(ISSUE_NO_L)).toBe(false);
	});
});

describe("systemOneGate end to end (default mode) with a judge that says dangerous", () => {
	test("the issue's command passes without asking the judge", async () => {
		const r = await systemOneGate(ISSUE_NO_L, process.env, ws);
		expect(r.run).toBe(true);
		expect(r.guard?.backend).toBe("allowlist");
		expect(judge.asks).toBe(0);
	});

	for (const cmd of [
		"curl -sL http://example.com/",
		"curl -s -c .tmp/cookies.txt -b .tmp/cookies.txt -D .tmp/headers.txt http://example.com/login",
		"curl -s https://api.github.com/",
		"curl -s -K x.cfg http://127.0.0.1:8080/",
		"curl -s file:///etc/passwd",
		"curl -s -d @/etc/passwd http://127.0.0.1:8080/",
	]) {
		test(`never the allowlist: ${cmd}`, async () => {
			const r = await systemOneGate(cmd, process.env, ws);
			expect(r.guard?.backend).not.toBe("allowlist");
		});
	}

	test("never allowed, by the deterministic refusal: the issue's -L command", async () => {
		const r = await systemOneGate(ISSUE_CMD, process.env, ws);
		expect(r.run).toBe(false);
		expect(r.guard?.verdict).toBe("block");
		expect(r.guard?.backend).toBe("allowlist");
		expect(r.message).toContain(CURL_L_REFUSAL);
		expect((curlToLoopback(ISSUE_CMD, ws) as { refuse?: string }).refuse).toBe(CURL_L_REFUSAL);
		expect(judge.asks).toBe(0);
	});

	test("strict mode (Guarded) never skips the judge", async () => {
		process.env[SYSTEM_ONE_FLAG] = "1";
		const r = await systemOneGate(ISSUE_NO_L, process.env, ws);
		expect(r.run).toBe(false);
		expect(r.guard?.backend).not.toBe("allowlist");
	});

	test("EIGHT_S1_ALLOWLIST=0 turns the lane off with the rest of the allowlist", async () => {
		process.env[SYSTEM_ONE_ALLOWLIST_FLAG] = "0";
		const r = await systemOneGate(ISSUE_NO_L, process.env, ws);
		expect(r.guard?.backend).not.toBe("allowlist");
	});
});

describe("-L to loopback is a deterministic refusal naming the way forward (#3967, 8SO)", () => {
	const URL = "http://127.0.0.1:41873/login";
	test("every spelling of -L to loopback refuses with the Location hint", () => {
		for (const c of [
			ISSUE_CMD,
			`curl -sL ${URL}`,
			`curl -s -L ${URL}`,
			`curl -s --location ${URL}`,
			`curl -sL -b .tmp/c.txt -c .tmp/c.txt ${URL}`,
			`curl -sL -d x=1 ${URL}`,
			`curl -s -L --max-redirs 1 ${URL}`,
		]) {
			const r = curlToLoopback(c, ws);
			expect(r.ok, c).toBe(false);
			expect((r as { refuse?: string }).refuse, c).toBe(CURL_L_REFUSAL);
		}
	});
	test("-L to a non-loopback URL has no refuse text", () => {
		for (const c of [
			"curl -sL http://example.com/",
			`curl -sL ${URL} http://example.com/`,
			"curl -sL http://169.254.169.254/",
		]) {
			const r = curlToLoopback(c, ws);
			expect(r.ok, c).toBe(false);
			expect((r as { refuse?: string }).refuse, c).toBeUndefined();
		}
	});
	test("the second request the refusal asks for passes", () => {
		expect(ok(ISSUE_NO_L)).toBe(true);
	});
});

describe("backslash inside double quotes (pilot 12 Oct, -w with \\n)", () => {
	test("a backslash before a letter or digit is literal and allowed", () => {
		expect(
			ok('curl -s -o .tmp/r.html -w "HTTP_STATUS:%{http_code}\\n" http://127.0.0.1:55376/'),
		).toBe(true);
		expect(ok('curl -s -w "a\\tb\\r\\n" http://127.0.0.1:55376/')).toBe(true);
	});
	test("any other backslash is refused, including one that would escape the closing quote", () => {
		expect(ok('curl -s -w "x\\" http://127.0.0.1:55376/')).toBe(false);
		expect(ok('curl -s -w "x\\\\n" http://127.0.0.1:55376/')).toBe(false);
		expect(ok('curl -s -w "x\\$HOME" http://127.0.0.1:55376/')).toBe(false);
		expect(ok('curl -s -H "a\\ b" http://127.0.0.1:55376/')).toBe(false);
		expect(ok('curl -s -w "\\`id\\`" http://127.0.0.1:55376/')).toBe(false);
	});
});

describe("systemOneGate with -L to loopback: refused without a judge call", () => {
	test("-L to loopback: blocked with the Location hint, judge never asked", async () => {
		const r = await systemOneGate(ISSUE_CMD, process.env, ws);
		expect(r.run).toBe(false);
		expect(r.message).toContain("Location");
		expect(r.message).toContain("Drop -L");
		expect(r.guard?.verdict).toBe("block");
		expect(judge.asks).toBe(0);
	});
	test("-L to a non-loopback URL still goes to the judge", async () => {
		const r = await systemOneGate("curl -sL http://example.com/", process.env, ws);
		expect(r.message ?? "").not.toContain("Drop -L");
		expect(r.guard?.backend).not.toBe("allowlist");
	});
});

describe("an output under .tmp/ with a script or config name: refused without a judge call (#4072)", () => {
	// The exact command from pilot run 2026-10-12_172356 seq 22 (styles.css and index.html passed the lane; app.js fell to the judge).
	const APP_JS = "curl -s http://127.0.0.1:65395/app.js -o .tmp/app.js";
	test("the pilot's command gets the name refusal, not NO", () => {
		expect(curlToLoopback(APP_JS, ws)).toEqual({ ok: false, refuse: CURL_OUT_NAME_REFUSAL });
	});
	test("the same fetch saved with a plain data name passes", () => {
		expect(ok("curl -s http://127.0.0.1:65395/app.js -o .tmp/app.js.txt")).toBe(true);
		expect(ok("curl -s http://127.0.0.1:65395/app.js -o .tmp/app-js")).toBe(true);
	});
	test("every write option and every spelling of a bad name", () => {
		for (const c of [
			"curl -s http://127.0.0.1:8080/ -o .tmp/a.ts",
			"curl -s http://127.0.0.1:8080/ -o .tmp/a.sh",
			"curl -s http://127.0.0.1:8080/ -o .tmp/a.py",
			"curl -s http://127.0.0.1:8080/ -o .tmp/a.yml",
			"curl -s http://127.0.0.1:8080/ -o .tmp/package.json",
			"curl -s http://127.0.0.1:8080/ -o .tmp/x.config.js",
			"curl -s http://127.0.0.1:8080/ --output .tmp/a.mjs",
			"curl -s http://127.0.0.1:8080/ -c .tmp/jar.sh",
			"curl -s http://127.0.0.1:8080/ -D .tmp/headers.toml",
			"curl -s -o.tmp/a.js http://127.0.0.1:8080/",
		]) {
			expect((curlToLoopback(c, ws) as { refuse?: string }).refuse, c).toBe(CURL_OUT_NAME_REFUSAL);
		}
	});
	test("a bad name outside .tmp/, or any other fault, is still plain NO (the judge decides as before)", () => {
		for (const c of [
			"curl -s http://127.0.0.1:8080/ -o app.js",
			"curl -s http://127.0.0.1:8080/ -o src/app.js",
			"curl -s http://127.0.0.1:8080/ -o /tmp/app.js",
			"curl -s http://127.0.0.1:8080/ -o .tmp/../app.js",
			"curl -s http://127.0.0.1:8080/ -o .tmp/node_modules/a.js",
			"curl -s http://example.com/app.js -o .tmp/app.txt",
			"curl -s http://127.0.0.1:8080/ -T .env",
		]) {
			expect(curlToLoopback(c, ws), c).toEqual({ ok: false });
		}
	});
	test("a bad name never passes with the rest of the command bad: a refusal is a block (-L, a non-loopback URL)", () => {
		for (const c of [
			"curl -sL http://127.0.0.1:8080/ -o .tmp/a.js",
			"curl -s http://example.com/ -o .tmp/a.js",
		]) {
			const r = curlToLoopback(c, ws);
			expect(r.ok, c).toBe(false);
		}
	});
	test("the gate blocks with the hint and never asks the judge", async () => {
		const r = await systemOneGate(APP_JS, process.env, ws);
		expect(r.run).toBe(false);
		expect(r.guard?.verdict).toBe("block");
		expect(r.guard?.backend).toBe("allowlist");
		expect(r.message).toContain(CURL_OUT_NAME_REFUSAL);
		expect(judge.asks).toBe(0);
	});
	test("strict mode (Guarded) goes to the judge, not the hint", async () => {
		process.env[SYSTEM_ONE_FLAG] = "1";
		const r = await systemOneGate(APP_JS, process.env, ws);
		expect(r.run).toBe(false);
		expect(r.guard?.backend).not.toBe("allowlist");
	});
});

describe("CURL_L_REFUSAL names the accepted form (#4303)", () => {
	test("the input shape is in the first sentence and says which flag to drop", () => {
		const first = CURL_L_REFUSAL.split(". ")[0];
		expect(first).toContain("curl -s -d @file http://127.0.0.1:<port>/path");
		expect(first).toContain("no -L");
		expect(CURL_L_REFUSAL).toContain("Drop -L");
	});
});
