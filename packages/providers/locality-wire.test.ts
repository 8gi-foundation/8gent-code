import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ModelFailover, NoAllowedProviderError } from "./failover";

import {
	LEDGER_TAIL_BYTES,
	type PolicyState,
	type RoutingPolicy,
	readLedger,
	recordCall,
	updateCall,
} from "./locality";
import { LocalOnlyRefusal, type WireDeps, bodySize, guardFetch, usageFrom } from "./locality-wire";

let dir: string;
let ledger: string;
beforeEach(() => {
	dir = mkdtempSync(join(tmpdir(), "wire-"));
	ledger = join(dir, "locality.jsonl");
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

type Handler = (url: string, init: any) => Response;

function rig(
	policy: RoutingPolicy,
	opts: { localHosts?: string[]; why?: string; handler?: Handler } = {},
) {
	const notices: string[] = [];
	const hits: Array<{ url: string; method: string; redirect?: string }> = [];
	const base = (async (input: any, init?: any) => {
		const url = String(input);
		hits.push({ url, method: String(init?.method ?? "GET"), redirect: init?.redirect });
		if (opts.handler) return opts.handler(url, init);
		const body = url.includes("minimax")
			? JSON.stringify({ usage: { prompt_tokens: 500, completion_tokens: 50 }, choices: [] })
			: 'data: {"x":1}\n\ndata: {"usage":{"prompt_tokens":100,"completion_tokens":20}}\n\ndata: [DONE]\n\n';
		return new Response(body, { status: 200 });
	}) as unknown as typeof fetch;
	const state: PolicyState = { policy, localHosts: opts.localHosts ?? [], why: opts.why };
	const deps: WireDeps = {
		state: () => state,
		nameOf: (hp, local) => (hp.includes("minimax") ? "minimax" : local ? "ollama" : hp),
		record: (c) => recordCall(c, ledger),
		update: (id, u) => updateCall(id, u, ledger),
		notify: (m) => notices.push(m),
	};
	return { f: guardFetch(base, deps), hits, notices };
}

const post = (f: typeof fetch, url: string, text = "hello", method = "POST") =>
	f(url, { method, body: JSON.stringify({ messages: [{ content: text }] }) }).then((r) => r.text());

describe("local-only at the wire", () => {
	test("a model request to an off-box host is refused before it is sent", async () => {
		const { f, hits } = rig("local-only");
		await expect(post(f, "https://api.minimax.io/v1/chat/completions")).rejects.toBeInstanceOf(
			LocalOnlyRefusal,
		);
		expect(hits).toEqual([]);
		expect(readLedger(ledger)).toEqual([]);
	});

	test("the refusal states exactly what is covered", async () => {
		const { f } = rig("local-only");
		const e = await post(f, "https://api.minimax.io/v1/messages").catch((x) => x);
		expect(e.message).toContain("local-only");
		expect(e.message).toContain("minimax");
		expect(e.message).toContain("model and network requests sent through 8gent's own HTTP client");
	});

	test("the gate is the method and the host, not the path", async () => {
		const { f, hits } = rig("local-only");
		const urls = [
			"https://api.replicate.com/v1/predictions",
			"https://api.minimax.io/v1/chat/completions;x=1",
			"https://api.minimax.io/v1%2Fchat%2Fcompletions",
			"https://api.minimax.io/v1/chat//completions",
			"https://api.minimax.io/anything/at/all",
			"https://evil.example/upload",
		];
		for (const u of urls) {
			await expect(post(f, u)).rejects.toBeInstanceOf(LocalOnlyRefusal);
		}
		for (const m of ["PUT", "PATCH", "DELETE", "POST"]) {
			await expect(post(f, "https://evil.example/x", "a", m)).rejects.toBeInstanceOf(
				LocalOnlyRefusal,
			);
		}
		expect(hits).toEqual([]);
	});

	test("GET and HEAD to any host still work", async () => {
		const { f, hits } = rig("local-only");
		await f("https://example.com/page.html").then((r) => r.text());
		await f("https://example.com/page.html", { method: "HEAD" }).then((r) => r.text());
		expect(hits).toHaveLength(2);
	});

	const loopbacks = [
		"http://127.0.0.1:11434/v1/chat/completions",
		"http://127.5.6.7:11434/api/chat",
		"http://[::1]:11434/api/chat",
		"http://[::ffff:127.0.0.1]:11434/api/chat",
		"http://localhost:11434/api/chat",
		"http://localhost.:11434/api/chat",
		"http://ollama.localhost:11434/api/chat",
		"http://2130706433:11434/api/chat",
	];
	for (const u of loopbacks) {
		test(`loopback form is local: ${u}`, async () => {
			const { f, hits } = rig("local-only");
			await post(f, u);
			expect(hits).toHaveLength(1);
		});
	}

	test("look-alike hosts are not loopback", async () => {
		const { f, hits } = rig("local-only");
		for (const u of [
			"http://127.0.0.1.evil.example/api/chat",
			"http://localhost.evil.example/api/chat",
			"http://128.0.0.1/api/chat",
		]) {
			await expect(post(f, u)).rejects.toBeInstanceOf(LocalOnlyRefusal);
		}
		expect(hits).toEqual([]);
	});

	test("a LAN host is refused until the user lists it in routing.localHosts", async () => {
		const off = rig("local-only");
		await expect(
			post(off.f, "http://192.168.1.20:1234/v1/chat/completions"),
		).rejects.toBeInstanceOf(LocalOnlyRefusal);
		const on = rig("local-only", { localHosts: ["192.168.1.20"] });
		await post(on.f, "http://192.168.1.20:1234/v1/chat/completions");
		expect(on.hits).toHaveLength(1);
		const withPort = rig("local-only", { localHosts: ["m5.local:1234"] });
		await post(withPort.f, "http://m5.local:1234/v1/chat/completions");
		await expect(
			post(withPort.f, "http://m5.local:9999/v1/chat/completions"),
		).rejects.toBeInstanceOf(LocalOnlyRefusal);
	});

	test("a redirect from a local host to an off-box host is refused, and not followed", async () => {
		const { f, hits } = rig("local-only", {
			handler: (url) =>
				url.startsWith("http://127.0.0.1")
					? new Response(null, { status: 307, headers: { location: "https://evil.example/steal" } })
					: new Response("leaked"),
		});
		await expect(post(f, "http://127.0.0.1:11434/api/chat")).rejects.toBeInstanceOf(
			LocalOnlyRefusal,
		);
		expect(hits.map((h) => h.url)).toEqual(["http://127.0.0.1:11434/api/chat"]);
		expect(hits[0].redirect).toBe("manual");
	});

	test("a redirect between local hosts is followed", async () => {
		const { f, hits } = rig("local-only", {
			handler: (url) =>
				url.endsWith("/old")
					? new Response(null, { status: 307, headers: { location: "http://localhost:11434/new" } })
					: new Response("ok"),
		});
		expect(await post(f, "http://127.0.0.1:11434/old")).toBe("ok");
		expect(hits.map((h) => h.url)).toEqual([
			"http://127.0.0.1:11434/old",
			"http://localhost:11434/new",
		]);
	});

	test("a POST redirected with 303 becomes a GET, which may leave; 307 may not", async () => {
		const mk = (code: number) =>
			rig("local-only", {
				handler: (url) =>
					url.startsWith("http://127.0.0.1")
						? new Response(null, {
								status: code,
								headers: { location: "https://example.com/page" },
							})
						: new Response("page"),
			});
		expect(await post(mk(303).f, "http://127.0.0.1:1/x")).toBe("page");
		await expect(post(mk(307).f, "http://127.0.0.1:1/x")).rejects.toBeInstanceOf(LocalOnlyRefusal);
	});

	test("a settings file that could not be read says so once, and the refusal carries the reason", async () => {
		const why = "settings.json could not be parsed, so model calls are held to this machine.";
		const { f, notices } = rig("local-only", { why });
		const e = await post(f, "https://api.minimax.io/v1/messages").catch((x) => x);
		await post(f, "https://api.minimax.io/v1/messages").catch(() => {});
		expect(e.message).toContain(why);
		expect(notices.filter((n) => n === why)).toHaveLength(1);
	});
});

describe("redirect hardening", () => {
	test("credentials are dropped when a redirect changes origin, kept when it does not", async () => {
		const seen: Array<{ url: string; auth: string | null; cookie: string | null }> = [];
		const { f } = rig("local-only", {
			handler: (url, init) => {
				const h = new Headers(init?.headers);
				seen.push({ url, auth: h.get("authorization"), cookie: h.get("cookie") });
				if (url === "http://127.0.0.1:1/a")
					return new Response(null, { status: 302, headers: { location: "http://127.0.0.1:1/b" } });
				if (url === "http://127.0.0.1:1/b")
					return new Response(null, {
						status: 302,
						headers: { location: "https://evil.example/leak" },
					});
				return new Response("end");
			},
		});
		await f("http://127.0.0.1:1/a", {
			headers: {
				Authorization: "Bearer SECRET",
				Cookie: "s=1",
				"Proxy-Authorization": "x",
				"X-Keep": "1",
			},
		}).then((r) => r.text());
		expect(seen.map((x) => x.url)).toEqual([
			"http://127.0.0.1:1/a",
			"http://127.0.0.1:1/b",
			"https://evil.example/leak",
		]);
		expect(seen[1].auth).toBe("Bearer SECRET"); // same origin: kept
		expect(seen[2].auth).toBeNull();
		expect(seen[2].cookie).toBeNull();
	});

	test("a caller's redirect manual or error is honoured", async () => {
		const redirecting: Handler = () =>
			new Response(null, { status: 302, headers: { location: "https://evil.example/x" } });
		const m = rig("local-only", { handler: redirecting });
		const r = await m.f("http://127.0.0.1:1/a", { redirect: "manual" });
		expect(r.status).toBe(302);
		expect(m.hits).toHaveLength(1);
		const e = rig("local-only", { handler: redirecting });
		await e.f("http://127.0.0.1:1/a", { redirect: "error" }).then((x) => x.text());
		expect(e.hits[0].redirect).toBe("error");
		expect(e.hits).toHaveLength(1);
	});
});

describe("ledger at the wire", () => {
	test("a turn plus two helper calls writes exactly one entry per provider call", async () => {
		const { f, hits } = rig("local-first");
		await post(f, "http://localhost:11434/v1/chat/completions"); // the turn (stream)
		await post(f, "http://localhost:11434/api/chat"); // summary helper
		await post(f, "https://api.minimax.io/v1/chat/completions"); // title helper on the cloud
		await f("http://localhost:11434/api/tags").then((r) => r.text()); // not a model call
		const got = readLedger(ledger);
		expect(hits).toHaveLength(4);
		expect(got).toHaveLength(3);
		expect(got.map((l) => [l.provider, l.local, l.tokensIn, l.tokensOut])).toEqual([
			["ollama", true, 100, 20],
			["ollama", true, 100, 20],
			["minimax", false, 500, 50],
		]);
		expect(got[2].bytesSent).toBeGreaterThan(0);
		expect(got[0].bytesSent).toBe(0);
	});

	test("the line exists at send time: a reply that is never read is still counted", async () => {
		const { f } = rig("local-first");
		await f("https://api.minimax.io/v1/chat/completions", {
			method: "POST",
			body: "x".repeat(400),
		});
		const [l] = readLedger(ledger);
		expect(l.provider).toBe("minimax");
		expect(l.bytesSent).toBe(400);
		expect(l.est).toBe(true);
		expect(l.tokensIn).toBe(100);
	});

	test("an off-box write that is not a model call is listed as other, never in the share", async () => {
		const { f } = rig("local-first");
		await post(f, "https://api.replicate.com/v1/files");
		const [l] = readLedger(ledger);
		expect(l.kind).toBe("other");
		expect(l.local).toBe(false);
	});

	test("a secret in the request never reaches the ledger or the notice", async () => {
		const { f, notices } = rig("local-first");
		const secret = "sk-live-SECRET-1a2b3c4d";
		await post(f, "https://api.minimax.io/v1/chat/completions", secret);
		expect(readFileSync(ledger, "utf8")).not.toContain(secret);
		expect(notices.join(" ")).not.toContain(secret);
	});

	test("no usage in the reply: tokens are estimated and marked", async () => {
		const { f } = rig("local-first", { handler: () => new Response("plain text reply!!") });
		await post(f, "http://127.0.0.1:11434/api/chat");
		const [l] = readLedger(ledger);
		expect(l.est).toBe(true);
		expect(l.tokensOut).toBe(Math.ceil("plain text reply!!".length / 4));
	});

	test("usage parsers: openai, anthropic stream, ollama", () => {
		expect(usageFrom("", '{"usage":{"prompt_tokens":7,"completion_tokens":3}}')).toEqual({
			in: 7,
			out: 3,
		});
		expect(
			usageFrom(
				'{"type":"message_start","usage":{"input_tokens":42}}',
				'{"usage":{"output_tokens":9}}',
			),
		).toEqual({ in: 42, out: 9 });
		expect(usageFrom("", '{"prompt_eval_count":5,"eval_count":11}')).toEqual({ in: 5, out: 11 });
		expect(usageFrom("", "nothing")).toBeNull();
	});

	test("body sizes: string, typed array, Blob, URLSearchParams, FormData, Request, stream", async () => {
		expect(await bodySize("héllo")).toEqual({ bytes: 6, known: true });
		expect(await bodySize(new Uint8Array(10))).toEqual({ bytes: 10, known: true });
		expect(await bodySize(new DataView(new ArrayBuffer(7)))).toEqual({ bytes: 7, known: true });
		expect(await bodySize(new Blob(["abcd"]))).toEqual({ bytes: 4, known: true });
		expect(await bodySize(new URLSearchParams({ a: "b" }))).toEqual({ bytes: 3, known: true });
		const fd = new FormData();
		fd.append("k", "vvv");
		fd.append("file", new Blob(["12345"]), "f.txt");
		expect((await bodySize(fd)).bytes).toBe(1 + 3 + 4 + 5);
		const req = new Request("https://x.example/", { method: "POST", body: "abcdef" });
		expect(await bodySize(undefined, req)).toEqual({ bytes: 6, known: true });
		expect((await bodySize(new ReadableStream())).known).toBe(false);
		expect(await bodySize(undefined)).toEqual({ bytes: 0, known: true });
	});
});

describe("cloud calls are said once, with the provider", () => {
	test("one notice per provider and policy, none for local", async () => {
		const { f, notices } = rig("local-first");
		await post(f, "http://127.0.0.1:11434/api/chat");
		await post(f, "https://api.minimax.io/v1/chat/completions");
		await post(f, "https://api.minimax.io/v1/chat/completions");
		expect(notices).toHaveLength(1);
		expect(notices[0]).toContain("minimax");
		expect(notices[0]).toContain("local-first");
	});
});

describe("failover under the policy", () => {
	const chains = () => ({
		text: {
			m: {
				models: [
					{ model: "m", provider: "ollama" },
					{ model: "m-cloud", provider: "openrouter" },
				],
			},
			cloudy: { models: [{ model: "c", provider: "openrouter" }] },
		},
		computer: {},
	});
	const make = (policy: RoutingPolicy) =>
		new ModelFailover(chains() as any, { allow: null, allowHosted: true, policy: () => policy });

	test("local-only: when the local provider is down the failover is refused, not sent to the cloud", () => {
		const fo = make("local-only");
		expect(fo.resolve("m").provider).toBe("ollama");
		fo.markDown("m", "ollama");
		// the only candidate left is local, so it is kept; the cloud entry is never offered
		expect(fo.resolve("m").provider).toBe("ollama");
		expect(() => fo.resolve("cloudy")).toThrow(NoAllowedProviderError);
		expect(() => fo.resolve("unknown-model")).toThrow(NoAllowedProviderError);
		expect(fo.nextHop("m", "ollama")).toBeNull();
	});

	test("local-first: the cloud entry is used only after the local one is down", () => {
		const fo = make("local-first");
		expect(fo.resolve("m").provider).toBe("ollama");
		fo.markDown("m", "ollama");
		expect(fo.resolve("m").provider).toBe("openrouter");
	});

	test("local-first puts a local entry ahead of a hosted one even if the chain lists it second", () => {
		const fo = new ModelFailover(
			{
				text: {
					m: {
						models: [
							{ model: "x", provider: "openrouter" },
							{ model: "m", provider: "ollama" },
						],
					},
				},
				computer: {},
			} as any,
			{ allow: null, allowHosted: true, policy: () => "local-first" },
		);
		expect(fo.resolve("m").provider).toBe("ollama");
	});

	test("cloud-first keeps the chain as written", () => {
		const fo = new ModelFailover(
			{
				text: {
					m: {
						models: [
							{ model: "x", provider: "openrouter" },
							{ model: "m", provider: "ollama" },
						],
					},
				},
				computer: {},
			} as any,
			{ allow: null, allowHosted: true, policy: () => "cloud-first" },
		);
		expect(fo.resolve("m").provider).toBe("openrouter");
	});
});

describe("ledger read is a tail", () => {
	test("a ledger bigger than the tail window is read from the end, whole lines only", () => {
		const line = (i: number) =>
			`${JSON.stringify({ ts: new Date().toISOString(), session: "s", provider: "ollama", local: true, tokensIn: i, tokensOut: 0, bytesSent: 0 })}\n`;
		const n = Math.ceil((LEDGER_TAIL_BYTES * 2) / line(1).length);
		let body = "";
		for (let i = 1; i <= n; i++) body += line(i);
		writeFileSync(ledger, body);
		expect(statSync(ledger).size).toBeGreaterThan(LEDGER_TAIL_BYTES);
		const got = readLedger(ledger);
		expect(got.length).toBeLessThan(n);
		expect(got.at(-1)?.tokensIn).toBe(n);
		expect(got.length).toBeGreaterThan(1000);
	});
});
