/**
 * Lean MCP access through the ToolExecutor, the text-tool path a local
 * model's turn runs on (#3474). Every run is a subprocess with its own temp
 * HOME, TMPDIR and cwd, a real MCPClient and a fake stdio MCP server, so
 * nothing reads or writes the real ~/.8gent and no network is used.
 *
 *   - three wirings: "today" (flag off, nothing connects, so no MCP tool is
 *     reachable), "naive" (flag off, client connected by hand with
 *     DRIVE_CONNECT=1: what plain wiring would put in context) and "lean"
 *     (flag on, the executor connects by itself)
 *   - flag off (unset, "", "0", "true", " 1", "1 ", "yes"): tool definitions,
 *     listing and call results are byte-identical to the unset baseline
 *     (the one normalisation: the ArtifactStore chip path carries the pid)
 *   - flag on ("1"): the executor advertises the lean tools, connects the
 *     server lazily, searches, fetches one schema, trims and spills
 *   - measured: characters each call puts into context, off vs on
 */

import { afterAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { SENTINEL } from "../mcp/lean.fixture";

const root = mkdtempSync(join(tmpdir(), "mcp-lean-exec-"));
afterAll(() => rmSync(root, { recursive: true, force: true }));
const pkg = resolve(import.meta.dir, "..");

const server = join(root, "server.ts");
writeFileSync(
	server,
	`import { FAKE_TOOLS, REPORT_TOOL, bigReport } from ${JSON.stringify(join(pkg, "mcp/lean.fixture.ts"))};
let buf = "";
const reply = (id, result) => process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id, result }) + "\\n");
for await (const chunk of process.stdin) {
	buf += chunk;
	let i;
	while ((i = buf.indexOf("\\n")) >= 0) {
		const line = buf.slice(0, i);
		buf = buf.slice(i + 1);
		if (!line.trim()) continue;
		const m = JSON.parse(line);
		if (m.id === undefined) continue;
		if (m.method === "initialize") reply(m.id, { protocolVersion: "2024-11-05", capabilities: { tools: {} }, serverInfo: { name: "fake", version: "0" } });
		else if (m.method === "tools/list") reply(m.id, { tools: [...FAKE_TOOLS, REPORT_TOOL] });
		else if (m.method === "tools/call") reply(m.id, { content: [{ type: "text", text: bigReport(m.params.arguments.quarter ?? "", m.params.arguments.rows ?? 400) + (m.params.arguments.secret ? " key=AKIAIOSFODNN7EXAMPLE" : "") }] });
	}
}
`,
);

const driver = join(root, "drive.ts");
writeFileSync(
	driver,
	`import { getMCPClient } from ${JSON.stringify(join(pkg, "mcp/index.ts"))};
import { ToolExecutor } from ${JSON.stringify(join(pkg, "eight/tools.ts"))};
import { registerTuiApprovalHandler } from ${JSON.stringify(join(pkg, "permissions/tui-approval-channel.ts"))};
registerTuiApprovalHandler(async () => "approve");
// Off runs connect by hand so the old path is compared against live tools;
// the lean path must connect by itself.
if (process.env.DRIVE_CONNECT === "1") await getMCPClient().connect();
const exec = new ToolExecutor(process.cwd(), "lean-drive");
const call = (args) => exec.execute("mcp_call_tool", { server: "work", tool: "ledger_quarter_report", ...args });
const out = {
	defs: JSON.stringify(exec.getToolDefinitions()),
	list: await exec.execute("mcp_list_tools", { query: "quarterly ledger report" }),
	schema: await exec.execute("mcp_list_tools", { tool: "ledger_quarter_report", server: "work" }),
	call50: await call({ args: { quarter: "2026-Q3" } }),
	call20: await call({ args: { quarter: "2026-Q3", rows: 150 } }),
	fields: await call({ args: { quarter: "2026-Q3" }, fields: ["totals.net"] }),
	secret: await call({ args: { quarter: "2026-Q3", rows: 150, secret: true } }),
};
console.log("RESULT" + JSON.stringify(out));
process.exit(0);
`,
);

type Out = Record<
	"defs" | "list" | "schema" | "call50" | "call20" | "fields" | "secret",
	string
> & {
	home: string;
};
const SECRET = "AKIAIOSFODNN7EXAMPLE";
let runs = 0;
function drive(lean: string | undefined, connect: boolean): Out {
	const dir = join(root, `run-${runs++}`);
	const home = join(dir, "home");
	const work = join(dir, "work");
	mkdirSync(join(home, ".8gent"), { recursive: true });
	mkdirSync(work);
	mkdirSync(join(dir, "tmp"));
	writeFileSync(
		join(home, ".8gent", "mcp.json"),
		JSON.stringify({ servers: { work: { command: process.execPath, args: [server] } } }),
	);
	const env: Record<string, string> = {
		PATH: process.env.PATH ?? "/usr/bin:/bin",
		HOME: home,
		// Windows reads USERPROFILE and TEMP/TMP, and needs SystemRoot to start at all.
		USERPROFILE: home,
		TEMP: join(dir, "tmp"),
		TMP: join(dir, "tmp"),
		...(process.env.SystemRoot ? { SystemRoot: process.env.SystemRoot } : {}),
		TMPDIR: join(dir, "tmp"),
		EIGHT_HEADLESS: "1",
	};
	if (lean !== undefined) env.EIGHT_MCP_LEAN = lean;
	if (connect) env.DRIVE_CONNECT = "1";
	const r = Bun.spawnSync([process.execPath, driver], {
		cwd: work,
		env,
		stdout: "pipe",
		stderr: "pipe",
		timeout: 60_000,
	});
	const line = r.stdout
		.toString()
		.split("\n")
		.find((l) => l.startsWith("RESULT"));
	if (!line)
		throw new Error(`driver failed (exit ${r.exitCode}): ${r.stderr.toString().slice(0, 2000)}`);
	// The ArtifactStore chip names its dir <agentId>-<pid>; the pid is the only per-process byte.
	const out = JSON.parse(
		line
			.slice(6)
			// The driver prints JSON, which doubles the backslashes of a Windows path.
			.replaceAll(JSON.stringify(home).slice(1, -1), "<HOME>")
			.replaceAll(home, "<HOME>")
			.replace(/lean-drive-\d+/g, "lean-drive-PID"),
	) as Out;
	return { ...out, home };
}

describe("flag off is byte-identical", () => {
	test("unset, empty, 0, true, ' 1', '1 ' and yes all behave as today", () => {
		const base = drive(undefined, true);
		expect(base.defs).not.toContain('"mcp_list_tools"');
		expect(base.list).toStartWith("Available MCP Tools:");
		expect(base.call20).toContain(SENTINEL); // today: the whole 20 KB answer
		expect(base.call50).toStartWith("[ARTIFACT "); // today: ArtifactStore's 50 KB chip (#2463)
		for (const v of ["", "0", "true", " 1", "1 ", "yes"]) {
			const s = drive(v, true);
			for (const k of ["defs", "list", "schema", "call50", "call20", "fields", "secret"] as const)
				expect(s[k]).toBe(base[k]);
		}
		// Today, with nothing connecting, the flag-off path reaches no server at all.
		const today = drive(undefined, false);
		expect(today.list).toBe("No MCP tools available. Configure servers in ~/.8gent/mcp.json");
		expect(today.call50).toBe('Server "work" not connected');
	}, 120_000);
});

describe("flag on: real client, fake stdio server, lazy connect", () => {
	test("search, one schema, trimmed and spilled answers; measured against off", () => {
		const off = drive(undefined, true);
		const on = drive("1", false);
		const names = (JSON.parse(on.defs) as Array<{ function: { name: string } }>).map(
			(d) => d.function.name,
		);
		expect(names.filter((n) => n.startsWith("mcp_"))).toEqual(["mcp_list_tools", "mcp_call_tool"]);
		expect(on.list.split("\n")[0]).toStartWith("- work/ledger_quarter_report:");
		expect(on.list.split("\n").filter((l) => l.startsWith("- ")).length).toBeLessThanOrEqual(8);
		expect(on.schema).toContain('"quarter"');
		expect(JSON.parse(on.fields)).toEqual({ "totals.net": 381300 });
		for (const k of ["call50", "call20"] as const) {
			expect(on[k]).not.toContain(SENTINEL);
			const path = /saved to (\S+)\]/.exec(on[k])?.[1] ?? "";
			expect(path.startsWith(join("<HOME>", ".8gent", "tool-results", "s-"))).toBe(true);
			expect(readFileSync(path.replace("<HOME>", on.home), "utf8")).toContain(SENTINEL);
		}
		// Secrets are scrubbed before the spill (#2464 order): not in the file, not in context.
		const sp = (/saved to (\S+)\]/.exec(on.secret)?.[1] ?? "").replace("<HOME>", on.home);
		expect(readFileSync(sp, "utf8")).toContain("[REDACTED:");
		expect(readFileSync(sp, "utf8")).not.toContain(SECRET);
		expect(on.secret).not.toContain(SECRET);
		// Lengths exclude the spill path and the ArtifactStore chip path, which depend on where HOME is.
		const bare = (t: string) =>
			t.replace(/saved to \S+\]/, "saved to ]").replace(/full at \S+\]/, "full at ]").length;
		const len = (o: Out, ks: Array<keyof Out>) => ks.map((k) => `${k}=${bare(o[k])}`).join(" ");
		console.log(
			`[#3474 executor] naive (flag off, hand-connected): ${len(off, ["list", "call50", "call20", "fields"])}`,
		);
		console.log(
			`[#3474 executor] lean (flag on, path excluded): ${len(on, ["list", "schema", "call50", "call20", "fields"])}`,
		);
		expect(on.list.length).toBeLessThan(off.list.length / 4);
		expect(bare(on.call20)).toBeLessThan(off.call20.length / 10);
		expect(on.fields.length).toBeLessThan(100);
	}, 120_000);
});

// Consent and Plan mode through the executor: a server that records its pid
// on start, so "nothing started" is read off the disk, not inferred.
const marked = join(root, "marked.ts");
writeFileSync(
	marked,
	`require("node:fs").appendFileSync(process.argv[2], process.pid + "\\n");
await import(${JSON.stringify(server)});
`,
);
const consentDriver = join(root, "consent.ts");
writeFileSync(
	consentDriver,
	`import { ToolExecutor } from ${JSON.stringify(join(pkg, "eight/tools.ts"))};
import { registerTuiApprovalHandler } from ${JSON.stringify(join(pkg, "permissions/tui-approval-channel.ts"))};
import { createPermissionHolder, runWithPermissionHolder } from ${JSON.stringify(join(pkg, "permissions/permission-mode.ts"))};
const mode = process.env.DRIVE_MODE;
const cards = [];
if (mode !== "headless" && mode !== "infinite")
	registerTuiApprovalHandler(async (req) => {
		cards.push(req.command ?? req.action);
		return mode === "deny" && req.action === "Start MCP servers" ? "deny" : "approve";
	});
const exec = new ToolExecutor(process.cwd(), "lean-consent");
const holder = mode === "plan" ? createPermissionHolder("plan") : mode === "infinite" ? createPermissionHolder("infinite") : undefined;
const run = (fn) => (holder ? runWithPermissionHolder(holder, fn) : fn());
const out = await run(async () => ({
	call: await exec.execute("mcp_call_tool", { server: "work", tool: "ledger_quarter_report", args: { quarter: "2026-Q3", rows: 2 } }),
	list: await exec.execute("mcp_list_tools", { query: "ledger" }),
	call2: await exec.execute("mcp_call_tool", { server: "work", tool: "ledger_quarter_report", args: { quarter: "2026-Q3", rows: 2 } }),
}));
console.log("RESULT" + JSON.stringify({ ...out, cards }));
process.exit(0);
`,
);

function consent(mode: "approve" | "deny" | "headless" | "plan" | "infinite") {
	const dir = join(root, `consent-${mode}`);
	const home = join(dir, "home");
	mkdirSync(join(home, ".8gent"), { recursive: true });
	mkdirSync(join(dir, "work"));
	mkdirSync(join(dir, "tmp"));
	const pids = join(dir, "pids");
	writeFileSync(pids, "");
	writeFileSync(
		join(home, ".8gent", "mcp.json"),
		JSON.stringify({
			servers: {
				work: {
					command: process.execPath,
					args: [marked, pids],
					env: { WORK_TOKEN: "env-never-on-card" },
				},
			},
		}),
	);
	const r = Bun.spawnSync([process.execPath, consentDriver], {
		cwd: join(dir, "work"),
		env: {
			PATH: process.env.PATH ?? "/usr/bin:/bin",
			HOME: home,
			TMPDIR: join(dir, "tmp"),
			EIGHT_MCP_LEAN: "1",
			DRIVE_MODE: mode,
			...(mode === "headless" || mode === "infinite" ? { EIGHT_HEADLESS: "1" } : {}),
		},
		stdout: "pipe",
		stderr: "pipe",
		timeout: 60_000,
	});
	const line = r.stdout
		.toString()
		.split("\n")
		.find((l) => l.startsWith("RESULT"));
	if (!line) throw new Error(`consent driver failed: ${r.stderr.toString().slice(0, 2000)}`);
	const out = JSON.parse(line.slice(6)) as {
		call: string;
		list: string;
		call2: string;
		cards: string[];
	};
	return { ...out, started: readFileSync(pids, "utf8").split("\n").filter(Boolean).length };
}

describe("flag on: no server starts without the person's yes", () => {
	test("approved: one start card naming the server, its command and its env names, never env values; one start", () => {
		const r = consent("approve");
		const start = r.cards.filter((c) => c.startsWith("start 1 MCP server from your MCP config"));
		expect(start.length).toBe(1);
		expect(start[0]).toContain(`\n- work: ${process.execPath} ${marked} `);
		expect(start[0]).toContain("(env: WORK_TOKEN)");
		// The per-call card is not blind: it names the call and its arguments.
		expect(r.cards).toContain(
			'mcp_call_tool work/ledger_quarter_report {"quarter":"2026-Q3","rows":2}',
		);
		expect(JSON.stringify(r.cards)).not.toContain("env-never-on-card");
		expect(r.started).toBe(1);
		expect(r.call).toContain("2026-Q3");
	}, 60_000);

	test("denied card: zero spawns from either tool, and the card is not asked again", () => {
		const r = consent("deny");
		expect(r.started).toBe(0);
		expect(r.call).toStartWith("[PERMISSION DENIED]");
		expect(r.list).toStartWith("[PERMISSION DENIED]");
		expect(r.call2).toStartWith("[PERMISSION DENIED]");
		expect(r.cards.filter((c) => c.startsWith("start ")).length).toBe(1);
	}, 60_000);

	test("headless with no card: refused, zero spawns", () => {
		const r = consent("headless");
		expect(r.started).toBe(0);
		expect(r.list).toStartWith("[BLOCKED]");
	}, 60_000);

	test("Plan mode: mcp_call_tool and mcp_list_tools spawn nothing", () => {
		const r = consent("plan");
		expect(r.started).toBe(0);
		expect(r.call).toStartWith("[PLAN MODE]");
		expect(r.list).toContain("not started in Plan mode");
		expect(r.cards).toEqual([]);
	}, 60_000);

	test("Infinite: starts without a card", () => {
		const r = consent("infinite");
		expect(r.cards).toEqual([]);
		expect(r.started).toBe(1);
	}, 60_000);
});
