/**
 * Lean MCP access (#3474): search, schema on demand, field projection and
 * spill to file, against a fake client (no server, no network). Every file
 * the code writes lands in a temp data dir. The before/after numbers are
 * measured through the ToolExecutor in packages/eight/tools-mcp-lean.test.ts.
 */

import { afterAll, describe, expect, test } from "bun:test";
import {
	existsSync,
	lstatSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	readdirSync,
	rmSync,
	statSync,
	symlinkSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { scrub } from "../eight/secret-scanner";
import type { ServerConfig } from "./config";
import {
	PREVIEW,
	RESULT_CAP,
	capResult,
	clean,
	leanCallTool,
	leanListTools,
	leanListToolsConnected,
	projectFields,
	storeResult,
} from "./lean";
import { describeServer, ensureConnected, isCredentialEnv } from "./lean";
import { FAKE_TOOLS, REPORT_TOOL, SENTINEL, bigReport } from "./lean.fixture";

/** A pass-through scrubber for tests that are not about secrets. */
const id = (t: string) => t;
/** The start card, answered yes, for tests that are not about consent. */
const yes = async () => null;
const root = mkdtempSync(join(tmpdir(), "mcp-lean-"));
afterAll(() => rmSync(root, { recursive: true, force: true }));
let n = 0;
const freshDataDir = () => {
	const d = join(root, `data-${n++}`);
	mkdirSync(d);
	return d;
};

const ENTRIES = [...FAKE_TOOLS, REPORT_TOOL].map((tool) => ({ server: "work", tool }));
function fakeClient(
	tools = ENTRIES,
	answer: unknown = { content: [{ type: "text", text: bigReport("2026-Q3") }] },
) {
	const calls: unknown[] = [];
	return {
		calls,
		connects: 0,
		listTools: () => tools,
		isConnected: () => true,
		loadServerConfigs: () => [{ type: "stdio" as const, name: "work", command: "work-server" }],
		close() {},
		async connect() {
			this.connects++;
		},
		async callTool(server: string, tool: string, args?: Record<string, unknown>) {
			calls.push({ server, tool, args });
			return answer as never;
		},
	};
}

describe("search and schema on demand", () => {
	test("a query returns at most 8 one-line matches, the right tool first", () => {
		const out = leanListTools(fakeClient(), { query: "quarterly ledger report" });
		const lines = out.split("\n").filter((l) => l.startsWith("- "));
		expect(lines.length).toBeGreaterThan(0);
		expect(lines.length).toBeLessThanOrEqual(8);
		expect(lines[0]).toStartWith("- work/ledger_quarter_report:");
		expect(out).not.toContain("inputSchema");
	});

	test("no arguments lists servers and counts only", () => {
		const out = leanListTools(fakeClient(), {});
		expect(out).toContain("work (41 tools)");
		expect(out).not.toContain("calendar_list");
	});

	test("tool fetches exactly one full schema", () => {
		const out = leanListTools(fakeClient(), { tool: "ledger_quarter_report" });
		expect(out).toContain('"quarter"');
		expect(out).toContain('"required"');
		expect(out).not.toContain("calendar_list");
	});

	test("an unknown tool or a name on two servers says so", () => {
		expect(leanListTools(fakeClient(), { tool: "nope" })).toContain("No MCP tool named");
		const two = [...ENTRIES, { server: "other", tool: REPORT_TOOL }];
		expect(leanListTools(fakeClient(two), { tool: REPORT_TOOL.name })).toContain("pass server");
		expect(leanListTools(fakeClient(two), { tool: REPORT_TOOL.name, server: "other" })).toContain(
			"other/ledger_quarter_report",
		);
	});

	test("no servers keeps today's message", () => {
		expect(leanListTools(fakeClient([]), { query: "x" })).toBe(
			"No MCP tools available. Configure servers in ~/.8gent/mcp.json",
		);
	});

	test("malformed tool entries from a server do not throw", () => {
		const odd = [
			{ server: "s", tool: null },
			{ server: "s", tool: { name: 7, description: 42 } },
			{ server: "s", tool: { name: "ok_tool", description: "x".repeat(100_000) } },
		] as never;
		expect(leanListTools(fakeClient(odd), { query: "ok" })).toContain("- s/ok_tool: ");
		expect(leanListTools(fakeClient(odd), { query: "42" })).toContain("- s/7: 42");
	});

	test("server-supplied control and bidi characters never reach the output", () => {
		const evil = [
			{
				server: "s\u001b]0;pwn\u0007",
				tool: { name: "a\u001b[2Jb", description: "x\u202edesc\u0000\nsecond line" },
			},
		];
		const out = leanListTools(fakeClient(evil), { query: "desc" });
		// biome-ignore lint/suspicious/noControlCharactersInRegex: asserting none survive
		expect(out).not.toMatch(/[\u0000-\u0008\u000b-\u001f\u007f-\u009f\u202e]/);
		expect(out).not.toContain("second line");
	});
});

describe("field projection", () => {
	const text = bigReport("2026-Q3");
	test("keeps only the requested paths", () => {
		const out = projectFields(text, ["totals.net", "quarter"]);
		expect(JSON.parse(out)).toEqual({ "totals.net": 381300, quarter: "2026-Q3" });
	});

	test("array indices and a comma string work", () => {
		const out = JSON.parse(projectFields(text, "rows.1.account, totals.currency"));
		expect(out).toEqual({ "rows.1.account": "ACC-0001", "totals.currency": "EUR" });
	});

	test("prototype keys and inherited properties are refused", () => {
		for (const f of [
			"__proto__",
			"constructor",
			"totals.__proto__.x",
			"prototype",
			"totals.toString",
			"totals.hasOwnProperty",
		]) {
			const out = projectFields(text, [f]);
			expect(out).toContain("[not found:");
			expect(out).toContain("top-level keys: quarter, totals, rows, audit");
		}
		expect(({} as Record<string, unknown>).polluted).toBeUndefined();
	});

	test("a JSON answer that tries to pollute the prototype cannot", () => {
		const out = projectFields('{"__proto__": {"polluted": 1}, "a": 2}', [
			"a",
			"__proto__.polluted",
		]);
		expect(out).toContain('"a": 2');
		expect(({} as Record<string, unknown>).polluted).toBeUndefined();
	});

	test("non-JSON and no fields pass through", () => {
		expect(projectFields("plain text", ["a"])).toBe(
			"[fields ignored: result is not JSON]\nplain text",
		);
		expect(projectFields(text, undefined)).toBe(text);
		expect(projectFields(text, [])).toBe(text);
	});
});

describe("spill to file", () => {
	test("under the cap is returned unchanged", () => {
		const d = freshDataDir();
		expect(capResult("small", d)).toBe("small");
		expect(existsSync(join(d, "tool-results"))).toBe(false);
	});

	test("under the cap, control and bidi characters are replaced; CRLF becomes LF", () => {
		const d = freshDataDir();
		expect(capResult("a\u001b[2Jb\u202ec\r\nd\te", d)).toBe("a?[2Jb?c\nd\te");
	});

	test("over the cap goes to a 0600 file in a per-session 0700 dir; the model gets path plus preview", () => {
		const d = freshDataDir();
		const big = bigReport("2026-Q3");
		const out = capResult(big, d);
		const path = /saved to (\S+)\]/.exec(out)?.[1] ?? "";
		expect(path.startsWith(join(d, "tool-results", "s-"))).toBe(true);
		expect(readFileSync(path, "utf8")).toBe(big);
		// Windows has no POSIX file modes (chmod is a no-op).
		if (process.platform !== "win32") expect(statSync(path).mode & 0o777).toBe(0o600);
		// Windows has no POSIX file modes (chmod is a no-op).
		if (process.platform !== "win32") expect(statSync(dirname(path)).mode & 0o777).toBe(0o700);
		// Measured without the path, whose length depends on TMPDIR.
		expect(out.replace(path, "").length).toBeLessThan(PREVIEW + 400);
		expect(out).not.toContain(SENTINEL);
		// A second spill in the same session uses the same dir and a new name.
		const path2 = /saved to (\S+)\]/.exec(capResult(big, d))?.[1] ?? "";
		expect(dirname(path2)).toBe(dirname(path));
		expect(path2).not.toBe(path);
	});

	test("a symlinked results dir is refused, nothing is written through it", () => {
		const d = freshDataDir();
		const elsewhere = join(root, `elsewhere-${n++}`);
		mkdirSync(elsewhere);
		symlinkSync(elsewhere, join(d, "tool-results"));
		const out = capResult("x".repeat(RESULT_CAP + 1), d);
		expect(out).toContain("could not be saved");
		expect(lstatSync(join(d, "tool-results")).isSymbolicLink()).toBe(true);
		expect(readdirSync(elsewhere)).toEqual([]);
	});

	test("store names files by its own handle", () => {
		const d = freshDataDir();
		const { handle, path } = storeResult("kept", d);
		expect(path).toBe(join(dirname(path), `${handle}.txt`));
		expect(readFileSync(path, "utf8")).toBe("kept");
	});

	test("the server's names never pick the file path", async () => {
		const d = freshDataDir();
		const c = fakeClient();
		const out = await leanCallTool(
			c,
			{ server: "../../etc", tool: "../passwd", args: {} },
			id,
			yes,
			d,
		);
		const path = /saved to (\S+)\]/.exec(out)?.[1] ?? "";
		expect(path.startsWith(join(d, "tool-results", "s-"))).toBe(true);
		expect(path).not.toContain("passwd");
	});
});

describe("leanCallTool", () => {
	test("fields shrink a large answer under the cap; nothing is spilled", async () => {
		const d = freshDataDir();
		const out = await leanCallTool(
			fakeClient(),
			{
				server: "work",
				tool: "ledger_quarter_report",
				args: { quarter: "2026-Q3" },
				fields: ["totals.net"],
			},
			id,
			yes,
			d,
		);
		expect(JSON.parse(out)).toEqual({ "totals.net": 381300 });
		expect(existsSync(join(d, "tool-results"))).toBe(false);
	});

	test("a malformed server answer does not throw", async () => {
		const d = freshDataDir();
		for (const bad of [
			null,
			{},
			{ content: "nope" },
			{ content: [null, 3, { type: "text", text: "ok" }] },
		]) {
			const out = await leanCallTool(
				fakeClient(ENTRIES, bad),
				{ server: "work", tool: "t" },
				id,
				yes,
				d,
			);
			expect(typeof out).toBe("string");
		}
	});

	test("connects lazily; a failed connect is retried once, then left alone", async () => {
		const c = { ...fakeClient(), isConnected: () => false };
		for (let i = 0; i < 4; i++)
			await leanCallTool(c, { server: "work", tool: "t" }, id, yes, freshDataDir());
		expect(c.connects).toBe(2);
		const ok = fakeClient();
		await leanCallTool(ok, { server: "work", tool: "t" }, id, yes, freshDataDir());
		expect(ok.connects).toBe(0);
	});

	test("in Plan mode listing never starts a server", async () => {
		const c = { ...fakeClient(), isConnected: () => false };
		const out = await leanListToolsConnected(c, { query: "ledger" }, false, yes);
		expect(c.connects).toBe(0);
		expect(out).toContain("not started in Plan mode");
		const running = fakeClient();
		expect(await leanListToolsConnected(running, { query: "ledger" }, false, yes)).toContain(
			"ledger_quarter_report",
		);
	});

	test("the scrubber runs before spill and preview: a secret never reaches the file", async () => {
		const d = freshDataDir();
		const secret = "AKIAIOSFODNN7EXAMPLE";
		const answer = {
			content: [{ type: "text", text: `key=${secret} ${"x".repeat(RESULT_CAP * 2)}` }],
		};
		const seen: string[] = [];
		const out = await leanCallTool(
			fakeClient(ENTRIES, answer),
			{ server: "work", tool: "t" },
			(t) => {
				seen.push(t);
				return t.replaceAll(secret, "[REDACTED:test]");
			},
			yes,
			d,
		);
		const path = /saved to (\S+)\]/.exec(out)?.[1] ?? "";
		expect(seen.length).toBe(1);
		expect(readFileSync(path, "utf8")).toContain("[REDACTED:test]");
		expect(readFileSync(path, "utf8")).not.toContain(secret);
		expect(out).not.toContain(secret);
	});

	test("clean caps before the regex runs", () => {
		expect(clean("a".repeat(5_000_000), 10)).toBe("a".repeat(10));
	});

	test("a secret unescaped by projection is scrubbed before spill: \\u0041 and \\/ forms", async () => {
		const key = "AKIAIOSFODNN7EXAMPLQ";
		const pass = "token=aB3dE5gH7jK9mN1pQ4rS6tU8";
		const escaped = `AKI\\u0041${key.slice(4)}`; // the raw JSON spells it with an escape
		const slashed = pass.replace("aB3", "aB3\\/"); // and this one with an escaped slash
		const pad = "x".repeat(RESULT_CAP * 2);
		const body = `{"data":{"k":"${escaped}","p":"${slashed}","pad":"${pad}"}}`;
		// The raw text does not show the AWS key to the scanner: only projection decodes it.
		expect(body).not.toContain(key);
		const d = freshDataDir();
		const out = await leanCallTool(
			fakeClient(ENTRIES, { content: [{ type: "text", text: body }] }),
			{ server: "work", tool: "t", fields: ["data"] },
			(t) => scrub(t).scrubbed,
			yes,
			d,
		);
		const path = /saved to (\S+)\]/.exec(out)?.[1] ?? "";
		const file = readFileSync(path, "utf8");
		expect(file.includes("[REDACTED:aws_access_key]")).toBe(true);
		expect(file.includes(key)).toBe(false);
		expect(file.includes("dE5gH7jK9mN1pQ4rS6tU8")).toBe(false);
		expect(out.includes(key)).toBe(false);
	});
});

describe("starting servers needs the person's yes (first-connect consent)", () => {
	const CONFIGS: ServerConfig[] = [
		{
			type: "stdio",
			name: "files",
			command: "/usr/local/bin/files-mcp",
			args: ["--root", "/srv"],
			env: { FILES_TOKEN: "env-value-never-shown" },
		},
		{
			type: "sse",
			name: "remote",
			url: "https://user:pw-never-shown@mcp.example.com/sse?key=q-never-shown",
			headers: { Authorization: "Bearer header-never-shown" },
		},
	];
	function startClient(configs = CONFIGS) {
		const connected: unknown[] = [];
		let up = false;
		let reads = 0;
		return {
			connected,
			get reads() {
				return reads;
			},
			listTools: () => (up ? ENTRIES : []),
			isConnected: () => up,
			loadServerConfigs: () => {
				reads++;
				return configs;
			},
			close() {},
			async connect(only?: ServerConfig[]) {
				connected.push(only);
				await Bun.sleep(20);
				up = true;
			},
			async callTool() {
				return { content: [{ type: "text", text: "ran" }] } as never;
			},
		};
	}

	test("the card names each server, its command plus args and its env NAMES, or its URL; never env values, headers or URL secrets", async () => {
		const cards: string[][] = [];
		const c = startClient();
		await leanListToolsConnected(c, { query: "x" }, true, async (s) => {
			cards.push(s);
			return null;
		});
		expect(cards).toEqual([
			[
				"files: /usr/local/bin/files-mcp --root /srv (env: FILES_TOKEN)",
				"remote: https://mcp.example.com/sse?...",
			],
		]);
		expect(JSON.stringify(cards)).not.toContain("never-shown");
		// Never cut: the whole line comes back, and the start refuses it (next test).
		expect(
			describeServer({ type: "stdio", name: "s", command: "c", args: ["x".repeat(1200)] }),
		).toBe(`s: c ${"x".repeat(1200)}`);
		// An arg with a space or a quote is quoted, so the card shows where args split.
		expect(
			describeServer({
				type: "stdio",
				name: "s",
				command: "/bin/sh",
				args: ["-c", "echo hi; rm x", ""],
			}),
		).toBe('s: /bin/sh -c "echo hi; rm x" ""');
		expect(describeServer({ type: "stdio", name: "a\u202eb", command: "x\u001b[2J" })).toBe(
			"a?b: x?[2J",
		);
	});

	test("config env: only credential names pass; every name 8SO probed in rounds 2 and 3 is refused", () => {
		for (const ok of [
			"GITHUB_PERSONAL_ACCESS_TOKEN",
			"BRAVE_API_KEY",
			"AWS_SECRET_ACCESS_KEY",
			"AWS_ACCESS_KEY_ID",
			"SLACK_TEAM_ID",
			"DB_PASSWORD",
			"CLIENT_SECRET",
		])
			expect(isCredentialEnv(ok)).toBe(true);
		for (const no of [
			"PATH",
			"NODE_OPTIONS",
			"NODE_PATH",
			"LD_PRELOAD",
			"DYLD_INSERT_LIBRARIES",
			"PYTHONPATH",
			"PYTHONSTARTUP",
			"PYTHONHOME",
			"BASH_ENV",
			"ENV",
			"PERL5OPT",
			"PERL5LIB",
			"PERL5DB",
			"RUBYOPT",
			"RUBYLIB",
			"npm_config_script_shell",
			"npm_config_key",
			"JAVA_TOOL_OPTIONS",
			"_JAVA_OPTIONS",
			"JDK_JAVA_OPTIONS",
			"HOME",
			"XDG_CONFIG_HOME",
			"PIP_INDEX_URL",
			"PIP_EXTRA_INDEX_URL",
			"UV_INDEX_URL",
			"UV_DEFAULT_INDEX",
			"PIPX_HOME",
			"SHELLOPTS",
			"BASHOPTS",
			"PS4",
			"ZDOTDIR",
			"GEM_HOME",
			"GEM_PATH",
			"BUNDLE_GEMFILE",
			"NODE_TLS_REJECT_UNAUTHORIZED",
			"NODE_EXTRA_CA_CERTS",
			"GOOGLE_APPLICATION_CREDENTIALS",
			"api_token",
			"_TOKEN",
		])
			expect(isCredentialEnv(no)).toBe(false);
	});

	test("a denied card means no server starts, from either tool, for the rest of the session", async () => {
		const c = startClient();
		let asked = 0;
		const no = async () => {
			asked++;
			return "[PERMISSION DENIED] declined";
		};
		expect(await leanCallTool(c, { server: "files", tool: "t" }, id, no, freshDataDir())).toBe(
			"[PERMISSION DENIED] declined",
		);
		expect(await leanListToolsConnected(c, { query: "x" }, true, no)).toBe(
			"[PERMISSION DENIED] declined",
		);
		expect(c.connected).toEqual([]);
		expect(asked).toBe(1);
	});

	test("no approval path at all means no start", async () => {
		const c = startClient();
		const out = await ensureConnected(c, true, undefined);
		expect(out).toStartWith("[BLOCKED]");
		expect(c.connected).toEqual([]);
	});

	test("exactly the approved list starts; the config is read once, also for the retry", async () => {
		const c = { ...startClient(), isConnected: () => false };
		let asked = 0;
		const ok = async () => {
			asked++;
			return null;
		};
		for (let i = 0; i < 3; i++) await ensureConnected(c, true, ok);
		expect(asked).toBe(1);
		expect(c.connected.length).toBe(2); // one start, one retry, then left alone
		for (const list of c.connected) expect(list).toBe(CONFIGS);
	});

	test("parallel first calls share one card and one start", async () => {
		const c = startClient();
		let asked = 0;
		const ok = async () => {
			asked++;
			await Bun.sleep(10);
			return null;
		};
		const outs = await Promise.all([
			leanCallTool(c, { server: "files", tool: "t" }, id, ok, freshDataDir()),
			leanCallTool(c, { server: "files", tool: "t" }, id, ok, freshDataDir()),
			leanListToolsConnected(c, { query: "ledger" }, true, ok),
		]);
		expect(asked).toBe(1);
		expect(c.connected.length).toBe(1);
		expect(outs[0]).toBe("ran");
	});

	test("no configured servers: no card, today's message", async () => {
		const c = startClient([]);
		let asked = 0;
		const out = await leanListToolsConnected(c, {}, true, async () => {
			asked++;
			return null;
		});
		expect(asked).toBe(0);
		expect(out).toBe("No MCP tools available. Configure servers in ~/.8gent/mcp.json");
	});
});
