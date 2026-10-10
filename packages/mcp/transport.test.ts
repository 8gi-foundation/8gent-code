/**
 * StdioTransport regression (#3479, found under #3474): Bun's spawn stdin is
 * a FileSink, and the old getWriter() call threw on every request, so no
 * stdio MCP server could connect. A fake server in a temp dir answers
 * initialize; no network, no real server.
 */

import { afterAll, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MAX_MESSAGE_CHARS, StdioTransport, serverEnv } from "./transport";

const dir = mkdtempSync(join(tmpdir(), "mcp-transport-"));
afterAll(() => rmSync(dir, { recursive: true, force: true }));
const server = join(dir, "server.ts");
writeFileSync(
	server,
	`let buf = "";
let notified = 0;
for await (const chunk of process.stdin) {
	buf += chunk;
	let i;
	while ((i = buf.indexOf("\\n")) >= 0) {
		const m = JSON.parse(buf.slice(0, i));
		buf = buf.slice(i + 1);
		if (m.id === undefined) { notified++; continue; }
		process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: m.id, result: { method: m.method, notified } }) + "\\n");
	}
}
`,
);

test("send and notify reach a stdio server and the answers come back in order", async () => {
	const t = new StdioTransport(process.execPath, [server], { HOME: dir, TMPDIR: dir });
	await t.start();
	try {
		expect(await t.send("initialize", {})).toEqual({ method: "initialize", notified: 0 });
		t.notify("notifications/initialized");
		expect(await t.send("tools/list")).toEqual({ method: "tools/list", notified: 1 });
	} finally {
		t.close();
	}
});

// One fake server for the hardening tests below, its behaviour picked by argv[2].
const odd = join(dir, "odd.ts");
writeFileSync(
	odd,
	`const mode = process.argv[2];
let buf = "";
const reply = (id, result) => process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id, result }) + "\\n");
for await (const chunk of process.stdin) {
	buf += chunk;
	let i;
	while ((i = buf.indexOf("\\n")) >= 0) {
		const m = JSON.parse(buf.slice(0, i));
		buf = buf.slice(i + 1);
		if (m.id === undefined) continue;
		if (m.method === "initialize") { reply(m.id, { pid: process.pid }); if (mode === "exit") process.exit(0); continue; }
		if (mode === "env") reply(m.id, { env: process.env });
		if (mode === "big") reply(m.id, { text: "y".repeat(6 * 1024 * 1024) });
		if (mode === "flood") { const mb = "a".repeat(1 << 20); for (let n = 0; n < 40; n++) await new Promise((r) => process.stdout.write(mb, r)); }
	}
}
`,
);
const alive = (pid: number) => {
	try {
		process.kill(pid, 0);
		return true;
	} catch {
		return false;
	}
};

test("a stdio server gets only the base environment plus its own config env", async () => {
	const prev = process.env.OPENROUTER_API_KEY;
	process.env.OPENROUTER_API_KEY = "sentinel-openrouter-key";
	const t = new StdioTransport(process.execPath, [odd, "env"], { OWN_VAR: "from-config" });
	try {
		await t.start();
		await t.send("initialize", {});
		const { env } = (await t.send("tools/list")) as { env: Record<string, string> };
		expect(env.OPENROUTER_API_KEY).toBeUndefined();
		expect(JSON.stringify(env)).not.toContain("sentinel-openrouter-key");
		expect(env.OWN_VAR).toBe("from-config");
		expect(env.PATH).toBe(process.env.PATH ?? "");
	} finally {
		t.close();
		if (prev === undefined) Reflect.deleteProperty(process.env, "OPENROUTER_API_KEY");
		else process.env.OPENROUTER_API_KEY = prev;
	}
});

test("serverEnv keeps the allowlist and LC_*, drops everything else, and lets config env win", () => {
	const env = serverEnv(
		{ HOME: "/cfg-home", X: "1" },
		{
			PATH: "/bin",
			HOME: "/h",
			LC_ALL: "C",
			LANG: "en",
			GITHUB_TOKEN: "t",
			AWS_SECRET_ACCESS_KEY: "s",
			PATHX: "no",
		},
	);
	expect(env).toEqual({ PATH: "/bin", HOME: "/cfg-home", LC_ALL: "C", LANG: "en", X: "1" });
});

test("a server flooding output with no newline is cut off at the cap: pending requests fail, the process is killed", async () => {
	const t = new StdioTransport(process.execPath, [odd, "flood"], {});
	await t.start();
	const { pid } = (await t.send("initialize", {})) as { pid: number };
	const err = await t.send("tools/list").then(
		() => "resolved",
		(e: Error) => e.message,
	);
	expect(err).toContain(`over ${MAX_MESSAGE_CHARS} characters`);
	await expect(t.send("tools/list")).rejects.toThrow(`over ${MAX_MESSAGE_CHARS}`);
	await Bun.sleep(200);
	expect(alive(pid)).toBe(false);
	t.close();
}, 30_000);

test("a large valid answer in many chunks is parsed in linear time", async () => {
	const t = new StdioTransport(process.execPath, [odd, "big"], {});
	try {
		await t.start();
		await t.send("initialize", {});
		const t0 = performance.now();
		const r = (await t.send("tools/list")) as { text: string };
		expect(r.text.length).toBe(6 * 1024 * 1024);
		expect(performance.now() - t0).toBeLessThan(5000);
	} finally {
		t.close();
	}
}, 30_000);

test("when the server exits, pending and later requests fail at once instead of waiting 30 s", async () => {
	const t = new StdioTransport(process.execPath, [odd, "exit"], {});
	await t.start();
	await t.send("initialize", {});
	const t0 = Date.now();
	await expect(t.send("tools/list")).rejects.toThrow();
	expect(Date.now() - t0).toBeLessThan(3000);
	expect(() => t.notify("x")).not.toThrow();
	t.close();
});

test("a server request that reuses our id does not settle our pending request", async () => {
	const spoof = join(dir, "spoof.ts");
	writeFileSync(
		spoof,
		`let buf = "";
for await (const chunk of process.stdin) {
	buf += chunk;
	let i;
	while ((i = buf.indexOf("\\n")) >= 0) {
		const m = JSON.parse(buf.slice(0, i));
		buf = buf.slice(i + 1);
		if (m.id === undefined) continue;
		process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: m.id, method: "sampling/createMessage", result: "spoofed" }) + "\\n");
		process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: m.id, result: "real" }) + "\\n");
	}
}
`,
	);
	const t = new StdioTransport(process.execPath, [spoof], { HOME: dir, TMPDIR: dir });
	await t.start();
	try {
		expect(await t.send("initialize", {})).toBe("real");
	} finally {
		t.close();
	}
});

test("an answer written just before the server exits is still delivered", async () => {
	const bye = join(dir, "bye.ts");
	writeFileSync(
		bye,
		`let buf = "";
for await (const chunk of process.stdin) {
	buf += chunk;
	const i = buf.indexOf("\\n");
	if (i < 0) continue;
	const m = JSON.parse(buf.slice(0, i));
	process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: m.id, result: { last: true } }) + "\\n", () => process.exit(0));
	break;
}
`,
	);
	const t = new StdioTransport(process.execPath, [bye], {});
	await t.start();
	try {
		expect(await t.send("initialize", {})).toEqual({ last: true });
		// The process is gone now: later requests fail at once, not after the 30 s timeout.
		const t0 = Date.now();
		await expect(t.send("tools/list")).rejects.toThrow();
		expect(Date.now() - t0).toBeLessThan(3000);
	} finally {
		t.close();
	}
}, 30_000);
