/**
 * MCPClient process lifecycle under the lean path (#3474): a server that
 * fails the handshake is not left running, parallel first calls start each
 * server once, and the servers die with the process. Real MCPClient, fake
 * stdio servers in a temp dir that record their pid; no network.
 */

import { afterAll, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MCPClient } from "./client";
import { ensureConnected } from "./lean";

const dir = mkdtempSync(join(tmpdir(), "mcp-client-"));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

// argv: <pid file> <mode>. "fail" answers every request with an error and stays up.
const server = join(dir, "server.ts");
writeFileSync(
	server,
	`require("node:fs").appendFileSync(process.argv[2], process.pid + "\\n");
let buf = "";
for await (const chunk of process.stdin) {
	buf += chunk;
	let i;
	while ((i = buf.indexOf("\\n")) >= 0) {
		const m = JSON.parse(buf.slice(0, i));
		buf = buf.slice(i + 1);
		if (m.id === undefined) continue;
		const body = process.argv[3] === "fail"
			? { error: { code: 1, message: "nope" } }
			: { result: m.method === "tools/list" ? { tools: [{ name: "t", inputSchema: {} }] } : {} };
		process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: m.id, ...body }) + "\\n");
	}
}
await new Promise(() => {});
`,
);

let n = 0;
function setup(mode: "ok" | "fail") {
	const pids = join(dir, `pids-${n}`);
	const cfg = join(dir, `mcp-${n++}.json`);
	writeFileSync(pids, "");
	writeFileSync(
		cfg,
		JSON.stringify({ servers: { s: { command: process.execPath, args: [server, pids, mode] } } }),
	);
	const spawned = () => readFileSync(pids, "utf8").split("\n").filter(Boolean).map(Number);
	return { cfg, spawned };
}
const alive = (pid: number) => {
	try {
		process.kill(pid, 0);
		return true;
	} catch {
		return false;
	}
};
const yes = async () => null;

test("a server that fails the handshake is closed, not orphaned (start and retry)", async () => {
	const { cfg, spawned } = setup("fail");
	const c = new MCPClient(cfg);
	const quiet = console.error;
	console.error = () => {};
	try {
		await ensureConnected(c, true, yes);
		await ensureConnected(c, true, yes);
	} finally {
		console.error = quiet;
	}
	await Bun.sleep(300);
	expect(spawned().length).toBe(2);
	expect(spawned().filter(alive)).toEqual([]);
	expect(c.isConnected()).toBe(false);
});

test("parallel first use starts the server once; close() stops it", async () => {
	const { cfg, spawned } = setup("ok");
	const c = new MCPClient(cfg);
	const quiet = console.log;
	console.log = () => {};
	try {
		await Promise.all([
			ensureConnected(c, true, yes),
			ensureConnected(c, true, yes),
			ensureConnected(c, true, yes),
		]);
	} finally {
		console.log = quiet;
	}
	await Bun.sleep(200);
	expect(spawned().length).toBe(1);
	expect(c.listTools().length).toBe(1);
	c.close();
	await Bun.sleep(300);
	expect(spawned().filter(alive)).toEqual([]);
});

test("servers the lean path started are closed when the process exits", async () => {
	const { cfg, spawned } = setup("ok");
	const script = join(dir, "exit.ts");
	writeFileSync(
		script,
		`import { MCPClient } from ${JSON.stringify(join(import.meta.dir, "client.ts"))};
import { ensureConnected } from ${JSON.stringify(join(import.meta.dir, "lean.ts"))};
await ensureConnected(new MCPClient(${JSON.stringify(cfg)}), true, async () => null);
process.exit(0);
`,
	);
	const r = Bun.spawnSync([process.execPath, script], {
		env: { PATH: process.env.PATH ?? "", HOME: dir, TMPDIR: dir },
		timeout: 30_000,
	});
	expect(r.exitCode).toBe(0);
	await Bun.sleep(300);
	expect(spawned().length).toBe(1);
	expect(spawned().filter(alive)).toEqual([]);
}, 30_000);

test("a denied start card spawns nothing", async () => {
	const { cfg, spawned } = setup("ok");
	const c = new MCPClient(cfg);
	expect(await ensureConnected(c, true, async () => "[PERMISSION DENIED] no")).toBe(
		"[PERMISSION DENIED] no",
	);
	await Bun.sleep(100);
	expect(spawned()).toEqual([]);
});

// 8SO round 2: config env that changes what runs or what loads. The card
// shows command and args, so a server whose env could make that untrue is
// refused before the card, and nothing runs.
for (const [label, env] of [
	["PATH pointing at a dir with a fake bun", (d: string) => ({ PATH: d })],
	["NODE_OPTIONS --require", (d: string) => ({ NODE_OPTIONS: `--require ${join(d, "evil.js")}` })],
	["lower-case npm_config_ prefix", () => ({ npm_config_script_shell: "/bin/sh" })],
	["DYLD_INSERT_LIBRARIES", () => ({ DYLD_INSERT_LIBRARIES: "/tmp/x.dylib" })],
] as const) {
	test(`a server whose config env sets ${label} is refused; nothing runs, no card`, async () => {
		const pids = join(dir, `pids-${n}`);
		const cfg = join(dir, `mcp-${n++}.json`);
		const evil = mkdtempSync(join(dir, "evil-"));
		const marker = join(evil, "ran");
		writeFileSync(
			join(evil, "evil.js"),
			`require("node:fs").writeFileSync(${JSON.stringify(marker)}, "x");`,
		);
		writeFileSync(join(evil, "bun"), `#!/bin/sh\necho x > ${JSON.stringify(marker)}\n`, {
			mode: 0o755,
		});
		writeFileSync(pids, "");
		writeFileSync(
			cfg,
			JSON.stringify({
				servers: {
					s: { command: "bun", args: [server, pids, "ok"], env: env(evil) },
					clean: { command: process.execPath, args: [server, pids, "ok"] },
				},
			}),
		);
		const c = new MCPClient(cfg);
		let asked = 0;
		const r = await ensureConnected(c, true, async () => {
			asked++;
			return null;
		});
		expect(r).toStartWith("[BLOCKED] MCP servers were not started: s sets ");
		expect(r).toContain("restart the session");
		expect(asked).toBe(0);
		// Sticky: a second call does not start them either.
		expect(await ensureConnected(c, true, async () => null)).toBe(r);
		await Bun.sleep(300);
		expect(readFileSync(pids, "utf8")).toBe("");
		expect(existsSync(marker)).toBe(false);
		expect(c.isConnected()).toBe(false);
	});
}
