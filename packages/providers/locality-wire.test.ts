import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ModelFailover, NoAllowedProviderError } from "./failover";
import { LEDGER_TAIL_BYTES, type RoutingPolicy, readLedger, recordCall } from "./locality";
import { LocalOnlyRefusal, type WireDeps, guardFetch, usageFrom } from "./locality-wire";

let dir: string;
let ledger: string;
beforeEach(() => {
	dir = mkdtempSync(join(tmpdir(), "wire-"));
	ledger = join(dir, "locality.jsonl");
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

function rig(policy: RoutingPolicy) {
	const notices: string[] = [];
	const hits: string[] = [];
	const base = (async (input: any, init?: any) => {
		const url = String(input);
		hits.push(url);
		const body = url.includes("minimax")
			? JSON.stringify({ usage: { prompt_tokens: 500, completion_tokens: 50 }, choices: [] })
			: 'data: {"x":1}\n\ndata: {"usage":{"prompt_tokens":100,"completion_tokens":20}}\n\ndata: [DONE]\n\n';
		return new Response(body, { status: 200 });
	}) as unknown as typeof fetch;
	const deps: WireDeps = {
		policy: () => policy,
		nameOf: (hp, local) => (hp.includes("minimax") ? "minimax" : local ? "ollama" : hp),
		record: (c) => recordCall(c, ledger),
		notify: (m) => notices.push(m),
	};
	return { f: guardFetch(base, deps), hits, notices };
}

const post = (f: typeof fetch, url: string, text = "hello") =>
	f(url, { method: "POST", body: JSON.stringify({ messages: [{ content: text }] }) }).then((r) =>
		r.text(),
	);

describe("local-only at the wire", () => {
	test("a request to an off-box inference host is refused before it is sent", async () => {
		const { f, hits } = rig("local-only");
		await expect(post(f, "https://api.minimax.io/v1/chat/completions")).rejects.toBeInstanceOf(
			LocalOnlyRefusal,
		);
		expect(hits).toEqual([]);
		expect(readLedger(ledger)).toEqual([]);
	});

	test("the refusal reads as plain words", async () => {
		const { f } = rig("local-only");
		const e = await post(f, "https://api.minimax.io/v1/messages").catch((x) => x);
		expect(e.message).toContain("local-only");
		expect(e.message).toContain("minimax");
		expect(e.message).toContain("Nothing left this machine");
	});

	test("loopback inference and non-inference calls still go through", async () => {
		const { f, hits } = rig("local-only");
		await post(f, "http://127.0.0.1:11434/v1/chat/completions");
		await f("https://example.com/page.html", { method: "POST", body: "x" }).then((r) => r.text());
		await f("https://api.github.com/repos/x/issues", { method: "GET" }).then((r) => r.text());
		expect(hits).toHaveLength(3);
	});
});

describe("ledger at the wire", () => {
	test("a turn plus two helper calls writes exactly one line per provider call", async () => {
		const { f, hits } = rig("local-first");
		await post(f, "http://localhost:11434/v1/chat/completions"); // the turn (stream)
		await post(f, "http://localhost:11434/api/chat"); // summary helper
		await post(f, "https://api.minimax.io/v1/chat/completions"); // title helper on the cloud
		await f("http://localhost:11434/api/tags", { method: "GET" }).then((r) => r.text()); // not inference
		const lines = readFileSync(ledger, "utf8")
			.trim()
			.split("\n")
			.map((l) => JSON.parse(l));
		expect(hits.filter((u) => !u.endsWith("/api/tags"))).toHaveLength(3);
		expect(lines).toHaveLength(3);
		expect(lines.map((l) => [l.provider, l.local, l.tokensIn, l.tokensOut])).toEqual([
			["ollama", true, 100, 20],
			["ollama", true, 100, 20],
			["minimax", false, 500, 50],
		]);
		expect(lines[2].bytesSent).toBeGreaterThan(0);
		expect(lines[0].bytesSent).toBe(0);
	});

	test("a secret in the request never reaches the ledger or the notice", async () => {
		const { f, notices } = rig("local-first");
		const secret = "sk-live-SECRET-1a2b3c4d";
		await post(f, "https://api.minimax.io/v1/chat/completions", secret);
		expect(readFileSync(ledger, "utf8")).not.toContain(secret);
		expect(notices.join(" ")).not.toContain(secret);
	});

	test("no usage in the reply: tokens are estimated and marked", async () => {
		const deps: WireDeps = {
			policy: () => "local-first",
			nameOf: () => "ollama",
			record: (c) => recordCall(c, ledger),
			notify: () => {},
		};
		const f = guardFetch((async () => new Response("plain text reply!!")) as any, deps);
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
