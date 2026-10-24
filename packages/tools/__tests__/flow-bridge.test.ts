/**
 * Flow bridge client (#4944): the phone TUI asks the 8gent Flow app's browser tab to open a
 * page and read it. These tests run against a FAKE Flow endpoint, a real loopback HTTP server
 * that checks the bearer token the way the app does. Nothing here touches the network.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
	type FlowDeps,
	PAIRING_FILE,
	bridgeFetch,
	clearPairing,
	newPairing,
	pairFlow,
	pairingLink,
	readPairing,
	runFlowCommand,
	writePairing,
} from "../flow-bridge";
import { webFetch } from "../web";

const TERMUX = { TERMUX_VERSION: "0.118" } as Record<string, string | undefined>;
const PLAIN = {} as Record<string, string | undefined>;

interface Seen {
	method: string;
	path: string;
	auth: string | null;
	host: string | null;
	body: unknown;
}

let dir: string;
let servers: { stop(close?: boolean): void }[] = [];

beforeEach(() => {
	dir = fs.mkdtempSync(path.join(os.tmpdir(), "flow-bridge-"));
});
afterEach(() => {
	for (const s of servers) s.stop(true);
	servers = [];
	fs.rmSync(dir, { recursive: true, force: true });
});

/** A fake Flow app. `reply` decides the answer to /v1/open. */
function fakeFlow(
	token: string,
	reply: (body: { url: string }) => Response = (b) =>
		Response.json({
			ok: true,
			url: b.url,
			title: "Fake page",
			text: "Hello from Flow",
			truncated: false,
		}),
) {
	const seen: Seen[] = [];
	const server = Bun.serve({
		hostname: "127.0.0.1",
		port: 0,
		async fetch(req) {
			const url = new URL(req.url);
			const raw = req.method === "POST" ? await req.text() : "";
			seen.push({
				method: req.method,
				path: url.pathname,
				auth: req.headers.get("authorization"),
				host: req.headers.get("host"),
				body: raw ? JSON.parse(raw) : null,
			});
			if (req.headers.get("authorization") !== `Bearer ${token}`)
				return Response.json({ ok: false, error: "not_paired" }, { status: 401 });
			if (url.pathname === "/v1/ping") return Response.json({ ok: true });
			if (url.pathname === "/v1/open") return reply(JSON.parse(raw));
			return Response.json({ ok: false, error: "not_found" }, { status: 404 });
		},
	});
	servers.push(server);
	return { port: server.port as number, seen };
}

function pairTo(port: number, token = "t".repeat(43)) {
	writePairing({ port, token }, dir);
	return { port, token };
}

const deps = (over: Partial<FlowDeps> = {}): FlowDeps => ({ env: TERMUX, dir, ...over });

describe("pairing file", () => {
	test("is written private and read back", () => {
		const p = newPairing();
		writePairing(p, dir);
		expect(fs.statSync(path.join(dir, PAIRING_FILE)).mode & 0o777).toBe(0o600);
		expect(readPairing(dir)).toEqual(p);
	});

	test("a fresh pairing has a url-safe 256-bit token and an unprivileged port", () => {
		const p = newPairing();
		expect(p.token).toMatch(/^[A-Za-z0-9_-]{43}$/);
		expect(p.port).toBeGreaterThanOrEqual(20000);
		expect(p.port).toBeLessThan(60000);
		expect(newPairing().token).not.toBe(p.token);
	});

	test("the link has the shape the app parses", () => {
		const p = { port: 41873, token: "a".repeat(43) };
		expect(pairingLink(p)).toBe(`eightgent://bridge?p=41873&t=${"a".repeat(43)}`);
	});

	test.each([
		["not json", "{{"],
		["port below 1024", JSON.stringify({ port: 80, token: "a".repeat(43) })],
		["port above 65535", JSON.stringify({ port: 70000, token: "a".repeat(43) })],
		["short token", JSON.stringify({ port: 41000, token: "short" })],
		["token with a space", JSON.stringify({ port: 41000, token: `${"a".repeat(42)} ` })],
		["extra shape", JSON.stringify([1, 2])],
	])("a bad file is ignored: %s", (_n, content) => {
		fs.writeFileSync(path.join(dir, PAIRING_FILE), content);
		expect(readPairing(dir)).toBeNull();
	});

	test("no file, no pairing; clear removes it", () => {
		expect(readPairing(dir)).toBeNull();
		writePairing(newPairing(), dir);
		clearPairing(dir);
		expect(readPairing(dir)).toBeNull();
		clearPairing(dir);
	});
});

describe("bridgeFetch: when it must do nothing", () => {
	test("no pairing: null, and nobody is asked", async () => {
		const flow = fakeFlow("t".repeat(43));
		expect(await bridgeFetch("https://example.com", {}, deps())).toBeNull();
		expect(flow.seen).toHaveLength(0);
	});

	test("not on Android: null even with a pairing file and a live endpoint", async () => {
		const flow = fakeFlow("t".repeat(43));
		pairTo(flow.port);
		expect(
			await bridgeFetch("https://example.com", {}, deps({ env: PLAIN, platform: "darwin" })),
		).toBeNull();
		expect(flow.seen).toHaveLength(0);
	});

	test("Flow absent (nothing listening): null, fast, no throw", async () => {
		const free = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => new Response("x") });
		const port = free.port as number;
		free.stop(true);
		pairTo(port);
		const t0 = Date.now();
		expect(await bridgeFetch("https://example.com", {}, deps())).toBeNull();
		expect(Date.now() - t0).toBeLessThan(1500);
	});

	test("Flow revoked the pairing (401): null", async () => {
		const flow = fakeFlow("other-token-other-token-other-token-aa");
		pairTo(flow.port);
		expect(await bridgeFetch("https://example.com", {}, deps())).toBeNull();
		expect(flow.seen.every((s) => s.path === "/v1/ping")).toBe(true);
	});

	test.each([
		[
			"blocked target",
			() => Response.json({ ok: false, error: "blocked_target" }, { status: 403 }),
		],
		["timeout", () => Response.json({ ok: false, error: "timeout" }, { status: 504 })],
		["not json", () => new Response("<html>", { status: 200 })],
		["ok but no text", () => Response.json({ ok: true, url: "https://x.test" })],
		["ok false with 200", () => Response.json({ ok: false, error: "x" })],
		["text is not a string", () => Response.json({ ok: true, url: "u", title: "t", text: 5 })],
	])("Flow says %s: null so the normal fetch runs", async (_n, reply) => {
		const flow = fakeFlow("t".repeat(43), reply);
		pairTo(flow.port);
		expect(await bridgeFetch("https://example.com", {}, deps())).toBeNull();
	});

	test("a slow Flow is abandoned at the timeout", async () => {
		const flow = fakeFlow("t".repeat(43), () => new Response(new ReadableStream({ start() {} })));
		pairTo(flow.port);
		const t0 = Date.now();
		expect(await bridgeFetch("https://example.com", {}, deps({ openTimeoutMs: 300 }))).toBeNull();
		expect(Date.now() - t0).toBeLessThan(2500);
	});
});

describe("bridgeFetch: paired and Flow answers", () => {
	test("returns the page text and sends exactly the request shape", async () => {
		const flow = fakeFlow("t".repeat(43));
		pairTo(flow.port);
		const r = await bridgeFetch("https://example.com/a", { maxLength: 1234 }, deps());
		expect(r).toEqual({
			title: "Fake page",
			url: "https://example.com/a",
			content: "Hello from Flow",
			length: "Hello from Flow".length,
		});
		const open = flow.seen.find((s) => s.path === "/v1/open")!;
		expect(open.method).toBe("POST");
		expect(open.auth).toBe(`Bearer ${"t".repeat(43)}`);
		expect(open.host).toBe(`127.0.0.1:${flow.port}`);
		expect(open.body).toEqual({ url: "https://example.com/a", max_bytes: 1234 });
	});

	test("only ever talks to 127.0.0.1, whatever the file says", async () => {
		const flow = fakeFlow("t".repeat(43));
		fs.writeFileSync(
			path.join(dir, PAIRING_FILE),
			JSON.stringify({ port: flow.port, token: "t".repeat(43), host: "evil.example" }),
		);
		await bridgeFetch("https://example.com", {}, deps());
		expect(flow.seen.every((s) => s.host === `127.0.0.1:${flow.port}`)).toBe(true);
	});

	test("content is cut to maxLength", async () => {
		const flow = fakeFlow("t".repeat(43), () =>
			Response.json({
				ok: true,
				url: "https://example.com",
				title: "T",
				text: "x".repeat(500),
				truncated: false,
			}),
		);
		pairTo(flow.port);
		const r = await bridgeFetch("https://example.com", { maxLength: 100 }, deps());
		expect(r?.content.length).toBe(100);
		expect(r?.length).toBe(500);
	});
});

describe("pairing is a yes that defaults to No", () => {
	const open = () => {
		const opened: string[] = [];
		return { opened, openLink: async (l: string) => void opened.push(l) };
	};

	test("not on Android: says so, asks nothing, writes nothing", async () => {
		const o = open();
		let asked = 0;
		const say: string[] = [];
		const code = await pairFlow(
			deps({
				env: PLAIN,
				platform: "darwin",
				ask: async () => {
					asked++;
					return true;
				},
				openLink: o.openLink,
				say: (l) => say.push(l),
			}),
		);
		expect(code).toBe(1);
		expect(asked).toBe(0);
		expect(readPairing(dir)).toBeNull();
		expect(say.join(" ")).toContain("Termux");
	});

	test("the question is y/N and a No leaves nothing behind", async () => {
		const o = open();
		const lines: { line: string; defaultYes: boolean }[] = [];
		const code = await pairFlow(
			deps({
				ask: async (line, defaultYes) => {
					lines.push({ line, defaultYes });
					return false;
				},
				openLink: o.openLink,
				say: () => {},
			}),
		);
		expect(code).toBe(1);
		expect(lines).toHaveLength(1);
		expect(lines[0].defaultYes).toBe(false);
		expect(lines[0].line).toMatch(/\[y\/N\]/);
		expect(lines[0].line).toContain("this phone");
		expect(readPairing(dir)).toBeNull();
		expect(o.opened).toHaveLength(0);
	});

	test("unattended (ask gives null) is a No", async () => {
		const o = open();
		const code = await pairFlow(
			deps({ ask: async () => null, openLink: o.openLink, say: () => {} }),
		);
		expect(code).toBe(1);
		expect(readPairing(dir)).toBeNull();
		expect(o.opened).toHaveLength(0);
	});

	test("a yes opens the link and is confirmed once Flow answers with the token", async () => {
		const o = open();
		const flows: { token: string; port: number }[] = [];
		const say: string[] = [];
		let started: { stop(close?: boolean): void } | null = null;
		const code = await pairFlow(
			deps({
				ask: async () => true,
				say: (l) => say.push(l),
				openLink: async (link) => {
					o.opened.push(link);
					const u = new URL(link);
					flows.push({ token: u.searchParams.get("t")!, port: Number(u.searchParams.get("p")) });
					// The person taps Allow: Flow starts listening on the port in the link.
					started = fakeFlowOn(flows[0].port, flows[0].token);
				},
				confirmTimeoutMs: 3000,
				pollMs: 50,
			}),
		);
		expect(code).toBe(0);
		expect(o.opened).toHaveLength(1);
		expect(o.opened[0]).toMatch(/^eightgent:\/\/bridge\?p=\d+&t=[A-Za-z0-9_-]{43}$/);
		expect(readPairing(dir)).toEqual(flows[0]);
		// The terminal shows the last four characters so the person can match the sheet.
		expect(say.join("\n")).toContain(flows[0].token.slice(-4));
		expect(started).not.toBeNull();
	});

	test("a yes that Flow never confirms removes the pairing again", async () => {
		const o = open();
		const say: string[] = [];
		const code = await pairFlow(
			deps({
				ask: async () => true,
				openLink: o.openLink,
				say: (l) => say.push(l),
				confirmTimeoutMs: 300,
				pollMs: 50,
			}),
		);
		expect(code).toBe(1);
		expect(readPairing(dir)).toBeNull();
		expect(say.join(" ")).toMatch(/nothing (was )?(changed|paired)/i);
	});
});

/** A fake Flow on a chosen port (the port the terminal put in the link). */
function fakeFlowOn(port: number, token: string) {
	const server = Bun.serve({
		hostname: "127.0.0.1",
		port,
		fetch: (req) =>
			req.headers.get("authorization") === `Bearer ${token}`
				? Response.json({ ok: true })
				: Response.json({ ok: false }, { status: 401 }),
	});
	servers.push(server);
	return server;
}

describe("8gent flow command", () => {
	test("status says paired or not, never prints the token", async () => {
		const flow = fakeFlow("t".repeat(43));
		const say: string[] = [];
		await runFlowCommand(["status"], deps({ say: (l) => say.push(l) }));
		expect(say.join(" ")).toMatch(/not paired/i);
		pairTo(flow.port);
		say.length = 0;
		const code = await runFlowCommand(["status"], deps({ say: (l) => say.push(l) }));
		expect(code).toBe(0);
		expect(say.join(" ")).toMatch(/paired/i);
		expect(say.join(" ")).not.toContain("t".repeat(43));
	});

	test("unpair removes the file", async () => {
		pairTo(41000);
		await runFlowCommand(["unpair"], deps({ say: () => {} }));
		expect(readPairing(dir)).toBeNull();
	});

	test("unknown subcommand prints usage and fails", async () => {
		const say: string[] = [];
		expect(await runFlowCommand(["bogus"], deps({ say: (l) => say.push(l) }))).toBe(2);
		expect(say.join(" ")).toContain("8gent flow pair");
	});
});

describe("web_fetch routing", () => {
	const saved = {
		EIGHT_HOME: process.env.EIGHT_HOME,
		TERMUX_VERSION: process.env.TERMUX_VERSION,
	};
	afterEach(() => {
		for (const [k, v] of Object.entries(saved)) {
			if (v === undefined) delete process.env[k];
			else process.env[k] = v;
		}
	});

	test("paired: web_fetch is answered by Flow and never touches the direct path", async () => {
		const flow = fakeFlow("t".repeat(43));
		const home = path.join(dir, "home");
		fs.mkdirSync(path.join(home, ".8gent"), { recursive: true });
		writePairing({ port: flow.port, token: "t".repeat(43) }, path.join(home, ".8gent"));
		process.env.EIGHT_HOME = home;
		process.env.TERMUX_VERSION = "0.118";
		const r = await webFetch("https://example.com/a", {
			net: {
				resolve: async () => {
					throw new Error("direct path must not run");
				},
				fetchImpl: (async () => {
					throw new Error("direct path must not run");
				}) as never,
			},
		});
		expect(r.content).toBe("Hello from Flow");
		expect(r.title).toBe("Fake page");
	});

	test("Flow gone: web_fetch runs exactly as before", async () => {
		const home = path.join(dir, "home");
		fs.mkdirSync(path.join(home, ".8gent"), { recursive: true });
		writePairing({ port: 41999, token: "t".repeat(43) }, path.join(home, ".8gent"));
		process.env.EIGHT_HOME = home;
		process.env.TERMUX_VERSION = "0.118";
		let direct = 0;
		const r = await webFetch("https://docs.example/", {
			net: {
				resolve: async () => [{ address: "93.184.216.34", family: 4 as const }],
				fetchImpl: (async () => {
					direct++;
					return new Response(
						"<html><head><title>Direct</title></head><body><p>direct body</p></body></html>",
						{
							headers: { "content-type": "text/html" },
						},
					);
				}) as never,
			},
		});
		expect(direct).toBe(1);
		expect(r.title).toBe("Direct");
	});

	test("not on Android: the bridge is never consulted", async () => {
		const flow = fakeFlow("t".repeat(43));
		const home = path.join(dir, "home");
		fs.mkdirSync(path.join(home, ".8gent"), { recursive: true });
		writePairing({ port: flow.port, token: "t".repeat(43) }, path.join(home, ".8gent"));
		process.env.EIGHT_HOME = home;
		// biome-ignore lint/performance/noDelete: assigning undefined would set the string "undefined"
		delete process.env.TERMUX_VERSION;
		await webFetch("https://docs.example/", {
			net: {
				resolve: async () => [{ address: "93.184.216.34", family: 4 as const }],
				fetchImpl: (async () =>
					new Response("<html><title>D</title></html>", {
						headers: { "content-type": "text/html" },
					})) as never,
			},
		}).catch(() => {});
		expect(flow.seen).toHaveLength(0);
	});
});
