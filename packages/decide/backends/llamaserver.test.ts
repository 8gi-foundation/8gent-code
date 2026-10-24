import { afterAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { loadCalibration } from "../calibrate";
import { createDecider } from "../index";
import { JUDGE_MODEL } from "../judge-model";
import { detectBackend } from "../probe";
import { DecideError, DecideUnavailableError } from "../types";
import {
	LLAMA_PORT,
	LLAMA_URL,
	LlamaServerBackend,
	llamaRecordPath,
	parseLlamaLogprobs,
	readLlamaKey,
	readLlamaRecord,
} from "./llamaserver";

const roots: string[] = [];
const home = () => {
	const d = mkdtempSync(join(tmpdir(), "llamaserver-"));
	roots.push(d);
	return d;
};
afterAll(() => {
	for (const d of roots) rmSync(d, { recursive: true, force: true });
});

const record = (over: Record<string, unknown> = {}) => ({
	keyFile: undefined as string | undefined,
	pid: 4242,
	bin: "/h/.8gent/bin/llama-server",
	startMs: 1,
	port: LLAMA_PORT,
	model: JUDGE_MODEL,
	gguf: "/h/.8gent/models/judge/x.gguf",
	...over,
});
function envWith(rec: unknown | null) {
	const h = home();
	const env = { EIGHT_HOME: h };
	if (rec !== null) {
		const p = llamaRecordPath(env) as string;
		mkdirSync(dirname(p), { recursive: true });
		writeFileSync(p, typeof rec === "string" ? rec : JSON.stringify(rec));
	}
	return env;
}

/** llama-server as the judge sees it: /health and /completion. */
function fakeServer(opts: { healthy?: boolean; completion?: () => Response } = {}) {
	const calls: { url: string; init?: RequestInit }[] = [];
	const fetchImpl = async (url: string | URL | Request, init?: RequestInit) => {
		const u = String(url);
		calls.push({ url: u, init });
		if (u === `${LLAMA_URL}/health`)
			return opts.healthy === false
				? new Response("loading", { status: 503 })
				: Response.json({ status: "ok" });
		if (u === `${LLAMA_URL}/completion`)
			return (
				opts.completion?.() ??
				Response.json({
					completion_probabilities: [
						{
							top_logprobs: [
								{ token: " Yes", logprob: Math.log(0.8) },
								{ token: " No", logprob: Math.log(0.15) },
							],
						},
					],
				})
			);
		return new Response("no", { status: 404 });
	};
	return { fetchImpl, calls };
}

describe("llama-server logprobs", () => {
	test("newer builds: completion_probabilities[0].top_logprobs", () => {
		expect(
			parseLlamaLogprobs({
				completion_probabilities: [
					{ top_logprobs: [{ token: "Yes", logprob: -0.1 }, { token: "No" }] },
				],
			}),
		).toEqual([{ token: "Yes", logprob: -0.1 }]);
	});

	test("older builds: probs of {tok_str, prob} become logprobs", () => {
		const r = parseLlamaLogprobs({
			completion_probabilities: [{ probs: [{ tok_str: "Yes", prob: 0.5 }] }],
		});
		expect(r?.[0].token).toBe("Yes");
		expect(r?.[0].logprob).toBeCloseTo(Math.log(0.5));
		expect(parseLlamaLogprobs({ probs: [{ tok_str: "No", prob: 0.25 }] })?.[0].token).toBe("No");
	});

	test("nothing usable is null", () => {
		expect(parseLlamaLogprobs({})).toBeNull();
		expect(parseLlamaLogprobs({ completion_probabilities: [{ top_logprobs: [] }] })).toBeNull();
		expect(parseLlamaLogprobs(null)).toBeNull();
	});
});

describe("LlamaServerBackend", () => {
	const ask = (b: LlamaServerBackend) =>
		b.ask({
			state: "chmod 000 notes.txt",
			questions: [{ id: "n", kind: "noul", prompt: "Is this destructive?" }],
		});

	test("the calibrated judge on llama.cpp: name llamacpp, the judge's model name, and a calibration exists", () => {
		const b = new LlamaServerBackend();
		expect(b.name).toBe("llamacpp");
		expect(b.model).toBe(JUDGE_MODEL);
		expect(loadCalibration(b.model, b.name)).not.toBeNull();
	});

	test("POSTs a raw one-token prompt to the loopback /completion, never following a redirect", async () => {
		const s = fakeServer();
		const res = await ask(new LlamaServerBackend({ fetch: s.fetchImpl }));
		const c = s.calls.find((x) => x.url.endsWith("/completion")) as {
			url: string;
			init: RequestInit;
		};
		expect(c.url).toBe("http://127.0.0.1:8091/completion");
		expect(c.init.redirect).toBe("error");
		const body = JSON.parse(String(c.init.body));
		expect(body).toMatchObject({
			n_predict: 1,
			n_probs: 20,
			temperature: 0,
			seed: 1,
			cache_prompt: false,
		});
		expect(body.prompt).toContain("chmod 000 notes.txt");
		expect(body.prompt.endsWith("Answer (yes or no):")).toBe(true);
		expect(res.backend).toBe("llamacpp");
		const a = res.answers[0] as { probabilities: { yes: number } };
		expect(a.probabilities.yes).toBeCloseTo(0.8 / 0.95, 5);
	});

	test("the per-start key is sent as a bearer token; without one no header is sent", async () => {
		const s = fakeServer();
		await ask(new LlamaServerBackend({ fetch: s.fetchImpl, apiKey: "k-123" }));
		const h = s.calls.find((x) => x.url.endsWith("/completion"))?.init?.headers as Record<
			string,
			string
		>;
		expect(h.authorization).toBe("Bearer k-123");
		const t = fakeServer();
		await ask(new LlamaServerBackend({ fetch: t.fetchImpl }));
		const h2 = t.calls.find((x) => x.url.endsWith("/completion"))?.init?.headers as Record<
			string,
			string
		>;
		expect(h2.authorization).toBeUndefined();
	});

	test("a server that cannot answer is Unavailable; an answer with no probabilities is an error", async () => {
		const down = new LlamaServerBackend({
			fetch: async () => {
				throw new Error("ECONNREFUSED");
			},
		});
		await expect(ask(down)).rejects.toBeInstanceOf(DecideUnavailableError);
		const e500 = new LlamaServerBackend({
			fetch: fakeServer({ completion: () => new Response("x", { status: 500 }) }).fetchImpl,
		});
		await expect(ask(e500)).rejects.toBeInstanceOf(DecideUnavailableError);
		const empty = new LlamaServerBackend({
			fetch: fakeServer({ completion: () => Response.json({}) }).fetchImpl,
		});
		await expect(ask(empty)).rejects.toBeInstanceOf(DecideError);
	});
});

describe("the judge points at llama-server, through the production entry points", () => {
	test("a record plus /health: detectBackend picks llamacpp at the loopback URL, no GGUF path", async () => {
		const s = fakeServer();
		const probe = await detectBackend({
			env: envWith(record()),
			fetch: s.fetchImpl,
			llamacppLoader: null,
		});
		expect(probe).toMatchObject({ backend: "llamacpp", model: JUDGE_MODEL, url: LLAMA_URL });
		expect(probe.path).toBeUndefined();
	});

	test("createDecider (auto) builds the llama-server backend and a verdict comes back", async () => {
		const s = fakeServer();
		const d = createDecider({ env: envWith(record()), fetch: s.fetchImpl, llamacppLoader: null });
		const b = await d.backend();
		expect(b).toBeInstanceOf(LlamaServerBackend);
		const res = await d.ask({
			state: "ls",
			questions: [{ id: "n", kind: "noul", prompt: "Destructive?" }],
		});
		expect(res.backend).toBe("llamacpp");
		expect(res.model).toBe(JUDGE_MODEL);
	});

	test("no record: llama-server is not even asked, so a stranger on the port is never trusted", async () => {
		const s = fakeServer();
		await detectBackend({
			env: { ...envWith(null), EIGHT_S1_SHARED_JUDGE: "0" },
			fetch: s.fetchImpl,
			llamacppLoader: null,
		}).catch(() => {});
		expect(s.calls.some((c) => c.url.startsWith(LLAMA_URL))).toBe(false);
	});

	test("createDecider reads the key from the record's key file and sends it", async () => {
		const env = envWith(null);
		const p = llamaRecordPath(env) as string;
		const keyFile = join(dirname(p), "llama-server.key");
		mkdirSync(dirname(p), { recursive: true });
		writeFileSync(keyFile, "from-file\n");
		writeFileSync(p, JSON.stringify(record({ keyFile })));
		expect(readLlamaKey(readLlamaRecord(env))).toBe("from-file");
		const s = fakeServer();
		const d = createDecider({ env, fetch: s.fetchImpl, llamacppLoader: null });
		await d.ask({ state: "ls", questions: [{ id: "n", kind: "noul", prompt: "Destructive?" }] });
		const h = s.calls.find((x) => x.url.endsWith("/completion"))?.init?.headers as Record<
			string,
			string
		>;
		expect(h.authorization).toBe("Bearer from-file");
		expect(readLlamaKey(null)).toBeNull();
		expect(readLlamaKey(readLlamaRecord(envWith(record({ keyFile: "/nope/x.key" }))))).toBeNull();
	});

	test("a record for another port, another model, or garbage is ignored", () => {
		expect(readLlamaRecord(envWith(record()))).not.toBeNull();
		expect(readLlamaRecord(envWith(record({ port: 8080 })))).toBeNull();
		expect(readLlamaRecord(envWith(record({ model: "llama3.2:3b" })))).toBeNull();
		expect(readLlamaRecord(envWith(record({ pid: 1 })))).toBeNull();
		expect(readLlamaRecord(envWith("not json"))).toBeNull();
		expect(readLlamaRecord({})).toBeNull();
	});

	test("recorded but not answering: noted, and the probe moves on", async () => {
		const s = fakeServer({ healthy: false });
		const probe = await detectBackend({
			env: { ...envWith(record()), EIGHT_S1_SHARED_JUDGE: "0", EIGHT_LOCAL_SERVER: "llama-server" },
			fetch: s.fetchImpl,
			llamacppLoader: null,
		});
		expect(probe.backend).not.toBe("llamacpp");
		expect(probe.notes.some((n) => n.includes("llama-server health 503"))).toBe(true);
	});
});
