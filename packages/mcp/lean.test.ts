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
	utimesSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
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
import { FAKE_TOOLS, REPORT_TOOL, SENTINEL, bigReport } from "./lean.fixture";

/** A pass-through scrubber for tests that are not about secrets. */
const id = (t: string) => t;
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

	test("over the cap goes to a 0600 file in a per-session 0700 dir; the model gets path plus preview", () => {
		const d = freshDataDir();
		const big = bigReport("2026-Q3");
		const out = capResult(big, d);
		const path = /saved to (\S+)\]/.exec(out)?.[1] ?? "";
		expect(path.startsWith(join(d, "tool-results", "s-"))).toBe(true);
		expect(readFileSync(path, "utf8")).toBe(big);
		expect(statSync(path).mode & 0o777).toBe(0o600);
		expect(statSync(dirname(path)).mode & 0o777).toBe(0o700);
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

	test("session dirs older than 7 days are pruned when a new session starts; newer ones and non-dirs stay", () => {
		const d = freshDataDir();
		const base = join(d, "tool-results");
		mkdirSync(join(base, "s-old"), { recursive: true, mode: 0o700 });
		writeFileSync(join(base, "s-old", "x.txt"), "x");
		mkdirSync(join(base, "s-recent"), { mode: 0o700 });
		writeFileSync(join(base, "s-file"), "not a dir");
		mkdirSync(join(base, "keep-me"));
		const eightDaysAgo = (Date.now() - 8 * 24 * 3600_000) / 1000;
		utimesSync(join(base, "s-old"), eightDaysAgo, eightDaysAgo);
		utimesSync(join(base, "keep-me"), eightDaysAgo, eightDaysAgo);
		storeResult("new", d);
		const left = readdirSync(base).sort();
		expect(left).not.toContain("s-old");
		expect(left).toContain("s-recent");
		expect(left).toContain("s-file");
		expect(left).toContain("keep-me");
	});

	test("the server's names never pick the file path", async () => {
		const d = freshDataDir();
		const c = fakeClient();
		const out = await leanCallTool(c, { server: "../../etc", tool: "../passwd", args: {} }, id, d);
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
				d,
			);
			expect(typeof out).toBe("string");
		}
	});

	test("connects lazily; a failed connect is retried once, then left alone", async () => {
		const c = { ...fakeClient(), isConnected: () => false };
		for (let i = 0; i < 4; i++)
			await leanCallTool(c, { server: "work", tool: "t" }, id, freshDataDir());
		expect(c.connects).toBe(2);
		const ok = fakeClient();
		await leanCallTool(ok, { server: "work", tool: "t" }, id, freshDataDir());
		expect(ok.connects).toBe(0);
	});

	test("in Plan mode listing never starts a server", async () => {
		const c = { ...fakeClient(), isConnected: () => false };
		const out = await leanListToolsConnected(c, { query: "ledger" }, false);
		expect(c.connects).toBe(0);
		expect(out).toContain("not started in Plan mode");
		const running = fakeClient();
		expect(await leanListToolsConnected(running, { query: "ledger" }, false)).toContain(
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
});
