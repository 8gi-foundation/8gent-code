/**
 * Dual-era MCP client (#3549). The 2026-07-28 revision drops the initialize
 * handshake: every request carries its version in `_meta`, servers answer
 * `server/discover`, and a client that only knows the handshake fails against
 * a modern-only server. Behind EIGHT_MCP_MODERN=1 the client probes modern
 * first and falls back to the 2024-11-05 handshake.
 *
 * Fake servers only: stdio servers in a temp dir, HTTP servers on 127.0.0.1.
 * Matrix: modern and legacy server x stdio and HTTP, plus the flag-off path.
 */

import { afterAll, afterEach, beforeAll, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MCPClient } from "./client";
import type { ServerConfig } from "./config";

const MODERN = "2026-07-28";
const V = "io.modelcontextprotocol/protocolVersion";
const dir = mkdtempSync(join(tmpdir(), "mcp-era-"));

// argv: <log file> <mode>. Every received message's method is appended to the log.
// modern:    answers server/discover; refuses initialize; needs _meta on every request.
// legacy:    answers initialize; unknown methods get -32601.
// silent:    legacy, but never answers an unknown method (some legacy servers do this).
// otherver:  modern, but only speaks a version we do not.
// oldonly:   refuses our modern version with -32022 listing 2024-11-05, then speaks legacy.
// discold:   answers server/discover listing only 2024-11-05, then speaks legacy.
const stdioServer = join(dir, "server.ts");
writeFileSync(
	stdioServer,
	`const [log, mode] = process.argv.slice(2);
const fs = require("node:fs");
const out = (m) => process.stdout.write(JSON.stringify({ jsonrpc: "2.0", ...m }) + "\\n");
const tools = [{ name: mode, inputSchema: { type: "object" } }];
let buf = "";
for await (const chunk of process.stdin) {
	buf += chunk;
	let i;
	while ((i = buf.indexOf("\\n")) >= 0) {
		const m = JSON.parse(buf.slice(0, i));
		buf = buf.slice(i + 1);
		fs.appendFileSync(log, m.method + "\\n");
		if (m.id === undefined) continue;
		const v = m.params?._meta?.["${V}"];
		if (m.method === "server/discover" && mode === "oldonly") {
			out({ id: m.id, error: { code: -32022, message: "Unsupported protocol version", data: { supported: ["2024-11-05"], requested: v } } });
			continue;
		}
		if (m.method === "server/discover" && mode === "discold") {
			out({ id: m.id, result: { resultType: "complete", supportedVersions: ["2024-11-05"], capabilities: { tools: {} } } });
			continue;
		}
		if (mode === "modern" || mode === "otherver") {
			const speaks = mode === "modern" ? ["${MODERN}"] : ["2099-01-01"];
			if (!speaks.includes(v)) {
				out({ id: m.id, error: { code: -32022, message: "Unsupported protocol version", data: { supported: speaks, requested: v } } });
			} else if (m.method === "server/discover") {
				out({ id: m.id, result: { resultType: "complete", supportedVersions: speaks, capabilities: { tools: {} } } });
			} else if (m.method === "tools/list") {
				out({ id: m.id, result: { resultType: "complete", tools } });
			} else if (m.method === "tools/call") {
				out({ id: m.id, result: { resultType: "complete", content: [{ type: "text", text: "v=" + v + " name=" + m.params.name }] } });
			} else out({ id: m.id, error: { code: -32601, message: "Method not found" } });
			continue;
		}
		if (m.method === "initialize") out({ id: m.id, result: { protocolVersion: "2024-11-05", capabilities: {} } });
		else if (m.method === "tools/list") out({ id: m.id, result: { tools } });
		else if (m.method === "tools/call") out({ id: m.id, result: { content: [{ type: "text", text: "legacy meta=" + JSON.stringify(m.params._meta ?? null) }] } });
		else if (mode !== "silent") out({ id: m.id, error: { code: -32601, message: "Method not found" } });
	}
}
`,
);

let n = 0;
function stdio(mode: string) {
	const log = join(dir, `log-${n}`);
	writeFileSync(log, "");
	const cfg: ServerConfig = {
		type: "stdio",
		name: `s${n++}`,
		command: process.execPath,
		args: [stdioServer, log, mode],
	};
	return { cfg, methods: () => readFileSync(log, "utf8").split("\n").filter(Boolean) };
}

// HTTP fakes. Modern: per spec, headers must mirror the body, a mismatch is
// 400 + -32020, a wrong version is 400 + -32022; tools/list answers as an SSE
// stream. Legacy: answers initialize, anything else unknown is a bare 404.
type Seen = { method: string; headers: Record<string, string | null> };
const seen: Record<string, Seen[]> = { modern: [], legacy: [] };
let modernUrl = "";
let legacyUrl = "";
let servers: ReturnType<typeof Bun.serve>[] = [];

beforeAll(() => {
	const json = (body: unknown, status = 200) => Response.json(body, { status });
	const modern = Bun.serve({
		port: 0,
		hostname: "127.0.0.1",
		async fetch(req) {
			const m = (await req.json()) as {
				id: number;
				method: string;
				params?: { name?: string; _meta?: Record<string, unknown> };
			};
			const h = (k: string) => req.headers.get(k);
			seen.modern.push({
				method: m.method,
				headers: {
					version: h("mcp-protocol-version"),
					method: h("mcp-method"),
					name: h("mcp-name"),
					accept: h("accept"),
				},
			});
			const v = m.params?._meta?.[V];
			if (h("mcp-protocol-version") !== v || h("mcp-method") !== m.method)
				return json(
					{ jsonrpc: "2.0", id: m.id, error: { code: -32020, message: "Header mismatch" } },
					400,
				);
			if (v !== MODERN)
				return json(
					{
						jsonrpc: "2.0",
						id: m.id,
						error: {
							code: -32022,
							message: "Unsupported protocol version",
							data: { supported: [MODERN] },
						},
					},
					400,
				);
			if (m.method === "server/discover")
				return json({
					jsonrpc: "2.0",
					id: m.id,
					result: {
						resultType: "complete",
						supportedVersions: [MODERN],
						capabilities: { tools: {} },
					},
				});
			if (m.method === "tools/list") {
				const progress = {
					jsonrpc: "2.0",
					method: "notifications/progress",
					params: { progress: 1 },
				};
				const done = {
					jsonrpc: "2.0",
					id: m.id,
					result: {
						resultType: "complete",
						tools: [{ name: "modern-http", inputSchema: { type: "object" } }],
					},
				};
				return new Response(
					`data: ${JSON.stringify(progress)}\n\n: keep-alive\n\ndata: ${JSON.stringify(done)}\n\n`,
					{
						headers: { "Content-Type": "text/event-stream" },
					},
				);
			}
			if (m.method === "tools/call") {
				if (h("mcp-name") !== m.params?.name)
					return json(
						{ jsonrpc: "2.0", id: m.id, error: { code: -32020, message: "Header mismatch" } },
						400,
					);
				return json({
					jsonrpc: "2.0",
					id: m.id,
					result: { resultType: "complete", content: [{ type: "text", text: `http v=${v}` }] },
				});
			}
			return json(
				{ jsonrpc: "2.0", id: m.id, error: { code: -32601, message: "Method not found" } },
				404,
			);
		},
	});
	const legacy = Bun.serve({
		port: 0,
		hostname: "127.0.0.1",
		async fetch(req) {
			const m = (await req.json()) as { id?: number; method: string };
			seen.legacy.push({ method: m.method, headers: {} });
			if (m.id === undefined) return new Response(null, { status: 202 });
			if (m.method === "initialize")
				return json({
					jsonrpc: "2.0",
					id: m.id,
					result: { protocolVersion: "2024-11-05", capabilities: {} },
				});
			if (m.method === "tools/list")
				return json({
					jsonrpc: "2.0",
					id: m.id,
					result: { tools: [{ name: "legacy-http", inputSchema: {} }] },
				});
			return new Response(null, { status: 404 });
		},
	});
	servers = [modern, legacy];
	modernUrl = `http://127.0.0.1:${modern.port}/mcp`;
	legacyUrl = `http://127.0.0.1:${legacy.port}/mcp`;
});

const flag = process.env.EIGHT_MCP_MODERN;
let clients: MCPClient[] = [];
afterEach(() => {
	for (const c of clients) c.close();
	clients = [];
	if (flag === undefined) delete process.env.EIGHT_MCP_MODERN;
	else process.env.EIGHT_MCP_MODERN = flag;
	seen.modern = [];
	seen.legacy = [];
});
afterAll(() => {
	for (const s of servers) s.stop(true);
	rmSync(dir, { recursive: true, force: true });
});

/** Connect quietly; return the client and what it logged as an error. */
async function connect(cfgs: ServerConfig[], modern: boolean) {
	if (modern) process.env.EIGHT_MCP_MODERN = "1";
	else delete process.env.EIGHT_MCP_MODERN;
	const c = new MCPClient(undefined, { probeTimeoutMs: 400 });
	clients.push(c);
	const errors: string[] = [];
	const [e, l] = [console.error, console.log];
	console.error = (...a: unknown[]) => errors.push(a.join(" "));
	console.log = () => {};
	try {
		await c.connect(cfgs);
	} finally {
		console.error = e;
		console.log = l;
	}
	return { c, errors };
}

const http = (name: string, url: string): ServerConfig => ({ type: "sse", name, url });

// ── Flag off: today's behaviour, byte for byte ───────────────────

test("flag off: legacy servers connect with the handshake and no probe is sent", async () => {
	const s = stdio("legacy");
	const { c, errors } = await connect([s.cfg, http("lh", legacyUrl)], false);
	expect(errors).toEqual([]);
	expect(s.methods()).toEqual(["initialize", "notifications/initialized", "tools/list"]);
	expect(seen.legacy.map((x) => x.method)).toEqual([
		"initialize",
		"notifications/initialized",
		"tools/list",
	]);
	expect(c.listServers().map((x) => x.toolCount)).toEqual([1, 1]);
});

test("flag off: a modern-only server is still unreachable (the gap this flag closes)", async () => {
	const s = stdio("modern");
	const { c } = await connect([s.cfg, http("mh", modernUrl)], false);
	expect(c.isConnected()).toBe(false);
});

// ── Flag on: the 4-cell matrix ───────────────────────────────────

test("modern stdio server: probe, stay modern, _meta on every request", async () => {
	const s = stdio("modern");
	const { c, errors } = await connect([s.cfg], true);
	expect(errors).toEqual([]);
	expect(s.methods()).toEqual(["server/discover", "tools/list"]);
	expect(c.listServers()).toEqual([
		{ name: s.cfg.name, toolCount: 1, type: "stdio", era: "modern", protocolVersion: MODERN },
	]);
	const r = await c.callTool(s.cfg.name, "modern", {});
	expect(r.isError).toBeFalsy();
	expect(r.content[0].text).toBe(`v=${MODERN} name=modern`);
});

test("modern HTTP server: headers mirror the body, SSE replies are read", async () => {
	const { c, errors } = await connect([http("mh", modernUrl)], true);
	expect(errors).toEqual([]);
	expect(c.listServers()).toEqual([
		{ name: "mh", toolCount: 1, type: "sse", era: "modern", protocolVersion: MODERN },
	]);
	expect(c.listTools().map((t) => t.tool.name)).toEqual(["modern-http"]);
	const r = await c.callTool("mh", "modern-http", { x: 1 });
	expect(r.content[0].text).toBe(`http v=${MODERN}`);
	const call = seen.modern.find((x) => x.method === "tools/call");
	expect(call?.headers).toEqual({
		version: MODERN,
		method: "tools/call",
		name: "modern-http",
		accept: "application/json, text/event-stream",
	});
	expect(seen.modern.map((x) => x.method)).not.toContain("initialize");
});

test("legacy stdio server: probe error that is not modern falls back to the handshake", async () => {
	const s = stdio("legacy");
	const { c, errors } = await connect([s.cfg], true);
	expect(errors).toEqual([]);
	expect(s.methods()).toEqual([
		"server/discover",
		"initialize",
		"notifications/initialized",
		"tools/list",
	]);
	expect(c.listServers()[0]).toMatchObject({ era: "legacy", protocolVersion: "2024-11-05" });
	// Legacy calls carry no modern _meta.
	const r = await c.callTool(s.cfg.name, "legacy", {});
	expect(r.content[0].text).toBe("legacy meta=null");
});

test("legacy HTTP server: a 4xx with no modern error body falls back to the handshake", async () => {
	const { c, errors } = await connect([http("lh", legacyUrl)], true);
	expect(errors).toEqual([]);
	expect(seen.legacy.map((x) => x.method)).toEqual([
		"server/discover",
		"initialize",
		"notifications/initialized",
		"tools/list",
	]);
	expect(c.listServers()[0]).toMatchObject({ name: "lh", toolCount: 1, era: "legacy" });
});

// ── Edges from the spec ──────────────────────────────────────────

test("a legacy server that never answers the probe falls back after the probe timeout", async () => {
	const s = stdio("silent");
	const t0 = Date.now();
	const { c, errors } = await connect([s.cfg], true);
	expect(errors).toEqual([]);
	expect(Date.now() - t0).toBeLessThan(5_000);
	expect(c.listServers()[0]).toMatchObject({ era: "legacy", toolCount: 1 });
});

test("a modern server that speaks no version we do is not sent initialize; the error says why", async () => {
	const s = stdio("otherver");
	const { c, errors } = await connect([s.cfg], true);
	expect(c.isConnected()).toBe(false);
	expect(s.methods()).toEqual(["server/discover"]);
	expect(errors.join("\n")).toContain("2099-01-01");
});

test("a server that refuses our modern version but lists 2024-11-05 gets the handshake", async () => {
	const s = stdio("oldonly");
	const { c, errors } = await connect([s.cfg], true);
	expect(errors).toEqual([]);
	expect(s.methods()).toEqual([
		"server/discover",
		"initialize",
		"notifications/initialized",
		"tools/list",
	]);
	expect(c.listServers()[0]).toMatchObject({ era: "legacy", toolCount: 1 });
});

test("a discover result that lists only 2024-11-05 gets the handshake", async () => {
	const s = stdio("discold");
	const { c, errors } = await connect([s.cfg], true);
	expect(errors).toEqual([]);
	expect(s.methods()).toEqual([
		"server/discover",
		"initialize",
		"notifications/initialized",
		"tools/list",
	]);
	expect(c.listServers()[0]).toMatchObject({ era: "legacy", toolCount: 1 });
});
