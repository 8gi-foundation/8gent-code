/**
 * 8gent as an MCP server answers both protocol eras (#3549): a 2024-11-05
 * client that sends `initialize`, and a 2026-07-28 client that calls
 * `server/discover` and carries its version in `_meta` without a handshake.
 * Real path: the 8gent server runs as a stdio child and MCPClient connects to it.
 */

import { afterAll, afterEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MCPClient } from "./client";
import type { ServerConfig } from "./config";
import { type MCPRPCError, StdioTransport } from "./transport";

const MODERN = "2026-07-28";
const V = "io.modelcontextprotocol/protocolVersion";
const dir = mkdtempSync(join(tmpdir(), "mcp-server-era-"));
writeFileSync(join(dir, "hello.txt"), "hello from the fixture\n");
const entry = join(dir, "entry.ts");
writeFileSync(
	entry,
	`import { startMCPServer } from ${JSON.stringify(join(import.meta.dir, "server.ts"))};
await startMCPServer(["--tools=safe", ${JSON.stringify(`--cwd=${dir}`)}]);
`,
);
const cfg: ServerConfig = {
	type: "stdio",
	name: "eight",
	command: process.execPath,
	args: [entry],
};

const flag = process.env.EIGHT_MCP_MODERN;
const open: Array<{ close(): void }> = [];
afterEach(() => {
	for (const o of open.splice(0)) o.close();
	if (flag === undefined) delete process.env.EIGHT_MCP_MODERN;
	else process.env.EIGHT_MCP_MODERN = flag;
});
afterAll(() => rmSync(dir, { recursive: true, force: true }));

async function connect(modern: boolean) {
	if (modern) process.env.EIGHT_MCP_MODERN = "1";
	else delete process.env.EIGHT_MCP_MODERN;
	const c = new MCPClient(undefined, { probeTimeoutMs: 10_000 });
	open.push(c);
	const errors: string[] = [];
	const [e, l] = [console.error, console.log];
	console.error = (...a: unknown[]) => errors.push(a.join(" "));
	console.log = () => {};
	try {
		await c.connect([cfg]);
	} finally {
		console.error = e;
		console.log = l;
	}
	return { c, errors };
}

test("a modern client connects with no initialize and calls a tool", async () => {
	const { c, errors } = await connect(true);
	expect(errors).toEqual([]);
	expect(c.listServers()[0]).toMatchObject({
		name: "eight",
		era: "modern",
		protocolVersion: MODERN,
	});
	expect(c.listTools().map((t) => t.tool.name)).toContain("read_file");
	const r = await c.callTool("eight", "read_file", { path: join(dir, "hello.txt") });
	expect(r.isError).toBeFalsy();
	expect(r.content[0].text).toContain("hello from the fixture");
}, 30_000);

test("a legacy client still connects with the handshake", async () => {
	const { c, errors } = await connect(false);
	expect(errors).toEqual([]);
	expect(c.listServers()[0]).toMatchObject({
		name: "eight",
		era: "legacy",
		protocolVersion: "2024-11-05",
	});
	expect(c.listTools().map((t) => t.tool.name)).toContain("read_file");
}, 30_000);

test("server/discover lists both versions; modern results are complete; legacy results are unchanged", async () => {
	const t = new StdioTransport(process.execPath, [entry]);
	open.push(t);
	await t.start();
	const meta = { _meta: { [V]: MODERN } };
	expect(await t.send("server/discover", meta)).toMatchObject({
		resultType: "complete",
		supportedVersions: [MODERN, "2024-11-05"],
		serverInfo: { name: "8gent-code" },
	});
	expect(await t.send("tools/list", meta)).toMatchObject({ resultType: "complete" });
	const legacy = (await t.send("initialize", {
		protocolVersion: "2024-11-05",
		capabilities: {},
		clientInfo: { name: "t", version: "0" },
	})) as Record<string, unknown>;
	expect(legacy.protocolVersion).toBe("2024-11-05");
	expect(legacy.resultType).toBeUndefined();
}, 30_000);

test("a request in a version the server does not speak gets -32022 with the supported list", async () => {
	const t = new StdioTransport(process.execPath, [entry]);
	open.push(t);
	await t.start();
	const err = (await t
		.send("tools/list", { _meta: { [V]: "2099-01-01" } })
		.catch((e) => e)) as MCPRPCError;
	expect(err.code).toBe(-32022);
	expect(err.data).toEqual({ supported: [MODERN, "2024-11-05"], requested: "2099-01-01" });
}, 30_000);
