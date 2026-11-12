import { describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { CLEAN_LINE, runCheckOffline } from "./check-offline.ts";

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
		expect(lines.join("\n")).toBe(CLEAN_LINE);
		expect(CLEAN_LINE).toContain("This is not proof that nothing leaves.");
		expect(CLEAN_LINE).toContain(
			"Not covered: ESM named imports, DNS/UDP, workers, child processes, native code",
		);
		expect(CLEAN_LINE).not.toContain("Nothing left this device");
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

	const caught = async (session: () => Promise<void>) => {
		const lines: string[] = [];
		const code = await runCheckOffline({ out: (l) => lines.push(l), session });
		return { code, text: lines.join("\n") };
	};

	test("loopback match is strict: 127.999.999.999 is refused, 127.0.0.2 passes", async () => {
		const bad = await caught(async () => {
			await fetch("http://127.999.999.999/").catch(() => {});
		});
		expect(bad.code).toBe(1);
		expect(bad.text).toContain("127.999.999.999");
		const ok = await caught(async () => {
			await fetch("http://127.0.0.2:9/").catch(() => {});
		});
		expect(ok.code).toBe(0);
	});

	test("a custom lookup on a localhost host is refused", async () => {
		const net = (await import("node:net")).default;
		const r = await caught(async () => {
			net.connect({ host: "localhost", port: 9, lookup: () => {} } as any);
		});
		expect(r.code).toBe(1);
		expect(r.text).toContain("localhost:9");
	});

	test("fetch with proxy or unix on a localhost URL is refused", async () => {
		const r = await caught(async () => {
			await fetch("http://localhost:9/", { proxy: "http://203.0.113.1:3128" } as any).catch(
				() => {},
			);
			await fetch("http://localhost:9/", { unix: "/tmp/x.sock" } as any).catch(() => {});
		});
		expect(r.code).toBe(1);
		expect(r.text).toContain("via proxy");
		expect(r.text).toContain("via unix");
	});

	test("WebSocket and Bun.connect to a remote host are caught", async () => {
		const r = await caught(async () => {
			try {
				new WebSocket("wss://203.0.113.5/socket");
			} catch {}
			try {
				await (globalThis as any).Bun.connect({
					hostname: "203.0.113.6",
					port: 4000,
					socket: { data() {} },
				});
			} catch {}
		});
		expect(r.code).toBe(1);
		expect(r.text).toContain("203.0.113.5");
		expect(r.text).toContain("203.0.113.6:4000");
	});
});
