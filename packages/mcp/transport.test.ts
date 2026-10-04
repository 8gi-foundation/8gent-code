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
import { StdioTransport } from "./transport";

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
