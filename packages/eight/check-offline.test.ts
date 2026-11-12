import { describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { findEnforcer, runCheckOffline, runListing, verdictLines } from "./check-offline.ts";

const tmp = (name: string, body: string) => {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "co-"));
	const file = path.join(dir, name);
	fs.writeFileSync(file, body);
	return file;
};

// Does this machine have a working OS network block? Enforced tests need it.
const enforcer = findEnforcer();
const enforced = enforcer ? test : test.skip;

describe("listing hooks (they only list; the OS is the guarantee)", () => {
	test("a module that calls fetch is listed", async () => {
		const file = tmp(
			"leaky.ts",
			`export function go() { return fetch("https://telemetry.example.com/ping"); }`,
		);
		const { attempts } = await runListing(async () => (await import(file)).go());
		expect(attempts.length).toBe(1);
		expect(attempts[0]).toMatchObject({ via: "fetch", host: "telemetry.example.com", port: "443" });
	});

	test("raw socket, lookup, proxy, unix, WebSocket and Bun.connect are listed", async () => {
		const net = (await import("node:net")).default;
		const { attempts } = await runListing(async () => {
			const t = (f: () => unknown) =>
				Promise.resolve()
					.then(f)
					.catch(() => {});
			await t(() => net.connect({ host: "203.0.113.9", port: 8443 }));
			await t(() => net.connect({ host: "localhost", port: 9, lookup: () => {} } as any));
			await t(() => fetch("http://localhost:9/", { proxy: "http://203.0.113.1:3128" } as any));
			await t(() => fetch("http://localhost:9/", { unix: "/tmp/x.sock" } as any));
			await t(() => new WebSocket("wss://203.0.113.5/socket"));
			await t(() =>
				(globalThis as any).Bun.connect({
					hostname: "203.0.113.6",
					port: 4000,
					socket: { data() {} },
				}),
			);
			await t(() => fetch("http://127.999.999.999/"));
		});
		expect(attempts.length).toBe(7);
	});

	test("hooks restore what they patched", async () => {
		const before = globalThis.fetch;
		await runListing(async () => {});
		expect(globalThis.fetch).toBe(before);
	});
});

describe("verdict", () => {
	test("the line names the OS mechanism and claims nothing about the rest", () => {
		const lines = verdictLines("sandbox-exec", []);
		expect(lines).toEqual([
			"check-offline: ran with outbound network blocked by the operating system (sandbox-exec). 0 attempt(s) were refused and listed below. Loopback and local sockets were allowed.",
		]);
		expect(lines.join(" ")).not.toMatch(/nothing left|not proof|hooks/i);
	});
});

describe("no enforcement", () => {
	test("no sandbox available: says so, exits 3, never prints a clean line", async () => {
		const lines: string[] = [];
		let spawned = false;
		const code = await runCheckOffline({
			sessionFile: "/nonexistent.ts",
			enforcer: null,
			out: (l) => lines.push(l),
			spawn: () => {
				spawned = true;
				return { status: 0, stdout: "" };
			},
		});
		expect(code).toBe(3);
		expect(spawned).toBe(false);
		expect(lines.join("\n")).toContain("no working way to block the network");
		expect(lines.join("\n")).not.toContain("blocked by the operating system");
	});

	test("a child that never reports is not a clean result", async () => {
		const lines: string[] = [];
		const code = await runCheckOffline({
			sessionFile: "/x.ts",
			enforcer: { mechanism: "fake", wrap: (a) => a },
			out: (l) => lines.push(l),
			spawn: () => ({ status: 0, stdout: "" }),
		});
		expect(code).toBe(3);
	});

	test("no local model: exits 2 and reaches out to nothing", async () => {
		const empty = fs.mkdtempSync(path.join(os.tmpdir(), "co-empty-"));
		const lines: string[] = [];
		const code = await runCheckOffline({ out: (l) => lines.push(l), modelRoot: empty });
		expect(code).toBe(2);
		expect(lines.join("\n")).toContain("no local model");
	});
});

describe("child protocol (identity wrapper, no OS block: tests the plumbing only)", () => {
	test("the child lists a leaky fetch and the parent exits 1 with the verdict line", async () => {
		const file = tmp(
			"leaky2.ts",
			`export default function () { return fetch("https://telemetry.example.com/ping"); }`,
		);
		const lines: string[] = [];
		const code = await runCheckOffline({
			sessionFile: file,
			enforcer: { mechanism: "plumbing-only", wrap: (a) => a },
			out: (l) => lines.push(l),
		});
		expect(code).toBe(1);
		expect(lines[0]).toContain("(plumbing-only). 1 attempt(s) were refused");
		expect(lines.join("\n")).toContain("telemetry.example.com:443");
	}, 60000);
});

describe("OS enforcement (needs sandbox-exec on macOS or unshare -rn on Linux)", () => {
	enforced(
		"a child cannot reach a remote address by any route, but can reach loopback",
		async () => {
			const server = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch: () => new Response("hi") });
			const file = tmp(
				"probe.ts",
				`
const REMOTE = "203.0.113.7";
const within = (p: Promise<unknown>) => Promise.race([p.then(() => "reached", () => "failed"), new Promise((r) => setTimeout(() => r("failed"), 4000))]);
export default async function () {
	const net = require("node:net");
	const out: Record<string, string> = {};
	out.loopback = await within(fetch("http://127.0.0.1:${server.port}/").then((r) => r.text()));
	out.bunFetch = await within((Bun as any).fetch("http://" + REMOTE + "/"));
	try { out.undici = await within(require("undici").fetch("http://" + REMOTE + "/")); } catch { out.undici = "failed"; }
	out.wsProxy = await within(new Promise((res, rej) => { const w = new (WebSocket as any)("ws://localhost:1/", { proxy: "http://" + REMOTE + ":3128" }); w.onopen = res; w.onerror = rej; w.onclose = rej; }));
	out.netConnect = await within(new Promise((res, rej) => { const s = net.connect({ host: REMOTE, port: 80 }); s.on("connect", res); s.on("error", rej); }));
	return out;
}`,
			);
			let captured: any;
			const code = await runCheckOffline({
				sessionFile: file,
				hooks: false, // hooks off: only the operating system stands in the way
				out: () => {},
				spawn: (argv) => {
					const { spawnSync } = require("node:child_process");
					const r = spawnSync(argv[0], argv.slice(1), {
						env: { ...process.env, CHECK_OFFLINE_SESSION: file, CHECK_OFFLINE_HOOKS: "0" },
						encoding: "utf8",
						timeout: 60000,
					});
					const m = (r.stdout as string)
						.split("\n")
						.find((l) => l.startsWith("__CHECK_OFFLINE_RESULT__"));
					captured = m ? JSON.parse(m.slice("__CHECK_OFFLINE_RESULT__".length)).result : null;
					return { status: r.status, stdout: r.stdout };
				},
			});
			server.stop(true);
			expect(captured).toBeTruthy();
			expect(captured.loopback).toBe("reached");
			expect(captured.bunFetch).toBe("failed");
			expect(captured.undici).toBe("failed");
			expect(captured.wsProxy).toBe("failed");
			expect(captured.netConnect).toBe("failed");
			expect(code).toBe(0);
		},
		90000,
	);
});
