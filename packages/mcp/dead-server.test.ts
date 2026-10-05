/**
 * A stdio MCP server that dies mid-session (#3542): the next call starts it
 * again once and succeeds; a server that cannot come back, or dies on every
 * call, leaves the tool list and the status instead of showing as connected
 * forever. Real MCPClient, fake stdio servers in a temp dir that record their
 * pid; no network.
 */

import { afterAll, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MCPClient } from "./client";

const dir = mkdtempSync(join(tmpdir(), "mcp-dead-"));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

// argv: <pid file> <mode> <marker>.
//   once:    answers one tools/call, then exits.
//   oneshot: like once, but a second start exits at once (it cannot restart).
//   crash:   exits on every tools/call without answering.
//   flaky:   the first start acts like once; later starts stay up.
const server = join(dir, "server.ts");
writeFileSync(
	server,
	`const fs = require("node:fs");
const [pids, mode, marker] = process.argv.slice(2);
if (mode === "oneshot" && fs.existsSync(marker)) process.exit(1);
const first = !fs.existsSync(marker);
if (mode === "oneshot" || mode === "flaky") fs.writeFileSync(marker, "x");
fs.appendFileSync(pids, process.pid + "\\n");
let buf = "";
for await (const chunk of process.stdin) {
	buf += chunk;
	let i;
	while ((i = buf.indexOf("\\n")) >= 0) {
		const m = JSON.parse(buf.slice(0, i));
		buf = buf.slice(i + 1);
		if (m.id === undefined) continue;
		if (m.method === "tools/call" && mode === "crash") process.exit(1);
		const result = m.method === "tools/list"
			? { tools: [{ name: "t", inputSchema: {} }] }
			: m.method === "tools/call" ? { content: [{ type: "text", text: "ok" }] } : {};
		process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: m.id, result }) + "\\n");
		if (m.method === "tools/call" && (mode !== "flaky" || first)) process.exit(0);
	}
}
await new Promise(() => {});
`,
);

let n = 0;
function setup(mode: "once" | "oneshot" | "crash" | "flaky") {
	const pids = join(dir, `pids-${n}`);
	const marker = join(dir, `marker-${n}`);
	const cfg = join(dir, `mcp-${n++}.json`);
	writeFileSync(pids, "");
	writeFileSync(
		cfg,
		JSON.stringify({
			servers: { s: { command: process.execPath, args: [server, pids, mode, marker] } },
		}),
	);
	const spawned = () => readFileSync(pids, "utf8").split("\n").filter(Boolean).map(Number);
	return { cfg, spawned, marker };
}
const alive = (pid: number) => {
	try {
		process.kill(pid, 0);
		return true;
	} catch {
		return false;
	}
};
const text = (r: { content: Array<{ text?: string }> }) => r.content.map((c) => c.text).join("");

async function quietly<T>(fn: () => Promise<T>): Promise<T> {
	const [log, err] = [console.log, console.error];
	console.log = console.error = () => {};
	try {
		return await fn();
	} finally {
		console.log = log;
		console.error = err;
	}
}

test("a server that exited is started again on the next call, which succeeds", async () => {
	const { cfg, spawned } = setup("once");
	const c = new MCPClient(cfg);
	await quietly(() => c.connect());
	expect(text(await c.callTool("s", "t"))).toBe("ok");
	await Bun.sleep(300); // the server exits after answering

	// Dead and not yet restarted: not advertised, not reported as connected.
	expect(c.listServers()).toEqual([]);
	expect(Object.keys(c.getTools())).toEqual([]);
	expect(c.listTools()).toEqual([]);

	const r = await quietly(() => c.callTool("s", "t"));
	expect(r.isError).toBeFalsy();
	expect(text(r)).toBe("ok");
	expect(spawned().length).toBe(2);
	c.close();
	await Bun.sleep(300);
	expect(spawned().filter(alive)).toEqual([]);
});

test("a server that cannot start again is dropped from tools and status", async () => {
	const { cfg, spawned, marker } = setup("oneshot");
	const c = new MCPClient(cfg);
	await quietly(() => c.connect());
	expect(text(await c.callTool("s", "t"))).toBe("ok");
	await Bun.sleep(300);
	expect(existsSync(marker)).toBe(true);

	const r = await quietly(() => c.callTool("s", "t"));
	expect(r.isError).toBe(true);
	expect(text(r)).toContain('MCP server "s" stopped');
	expect(c.listServers()).toEqual([]);
	expect(Object.keys(c.getTools())).toEqual([]);

	// Gone for good: the next call does not try again.
	const again = await quietly(() => c.callTool("s", "t"));
	expect(again.isError).toBe(true);
	expect(text(again)).toContain("not connected");
	await Bun.sleep(300);
	expect(spawned().length).toBe(1);
	expect(spawned().filter(alive)).toEqual([]);
});

test("a server that dies on every call is restarted once, then dropped (no loop)", async () => {
	const { cfg, spawned } = setup("crash");
	const c = new MCPClient(cfg);
	await quietly(() => c.connect());

	// Dies during the call: not re-sent (it may have acted), but started again.
	const first = await quietly(() => c.callTool("s", "t"));
	expect(first.isError).toBe(true);
	expect(spawned().length).toBe(2);
	expect(c.listServers().length).toBe(1);

	// Dies again before ever answering: dropped, not restarted a third time.
	const second = await quietly(() => c.callTool("s", "t"));
	expect(second.isError).toBe(true);
	expect(text(second)).toContain('MCP server "s" stopped');
	expect(c.listServers()).toEqual([]);
	await quietly(() => c.callTool("s", "t"));
	await Bun.sleep(300);
	expect(spawned().length).toBe(2);
	expect(spawned().filter(alive)).toEqual([]);
});

test("parallel calls to a dead server start it once", async () => {
	const { cfg, spawned } = setup("flaky");
	const c = new MCPClient(cfg);
	await quietly(() => c.connect());
	await c.callTool("s", "t");
	await Bun.sleep(300);
	const rs = await quietly(() =>
		Promise.all([c.callTool("s", "t"), c.callTool("s", "t"), c.callTool("s", "t")]),
	);
	expect(rs.map(text)).toEqual(["ok", "ok", "ok"]);
	// One restart for three callers, never three processes.
	expect(spawned().length).toBe(2);
	c.close();
	await Bun.sleep(300);
	expect(spawned().filter(alive)).toEqual([]);
});
