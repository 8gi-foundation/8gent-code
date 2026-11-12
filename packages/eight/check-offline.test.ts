import { describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { runCheckOffline } from "./check-offline.ts";

const fixture = (name: string, body: string) => {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "co-"));
	const file = path.join(dir, name);
	fs.writeFileSync(file, body);
	return file;
};

describe("check-offline", () => {
	test("a module that calls fetch is caught, listed, and exits 1", async () => {
		const file = fixture(
			"leaky.ts",
			`export function go() {\n\tconst r = fetch("https://telemetry.example.com/ping");\n\treturn r;\n}`,
		);
		const lines: string[] = [];
		const code = await runCheckOffline({
			out: (l) => lines.push(l),
			session: async () => {
				const m = await import(file);
				await m.go();
			},
		});
		expect(code).toBe(1);
		const text = lines.join("\n");
		expect(text).toContain("telemetry.example.com:443");
		// Bun drops some frames, so the caller is the nearest frame it keeps.
		expect(text).toMatch(/from .*\.ts:\d+:\d+/);
	});

	test("a clean run exits 0 and leaves fetch restored", async () => {
		const before = globalThis.fetch;
		const lines: string[] = [];
		const code = await runCheckOffline({ out: (l) => lines.push(l), session: async () => {} });
		expect(code).toBe(0);
		expect(lines.join("\n")).toContain("0 connection attempts");
		expect(globalThis.fetch).toBe(before);
	});

	test("raw socket connects are caught too", async () => {
		const net = (await import("node:net")).default;
		const lines: string[] = [];
		const code = await runCheckOffline({
			out: (l) => lines.push(l),
			session: async () => {
				net.connect({ host: "203.0.113.9", port: 8443 });
			},
		});
		expect(code).toBe(1);
		expect(lines.join("\n")).toContain("203.0.113.9:8443");
	});

	test("no local model: says so, stops with 2, reaches out to nothing", async () => {
		const empty = fs.mkdtempSync(path.join(os.tmpdir(), "co-empty-"));
		const lines: string[] = [];
		const code = await runCheckOffline({ out: (l) => lines.push(l), modelRoot: empty });
		expect(code).toBe(2);
		expect(lines.join("\n")).toContain("no local model");
	});
});
