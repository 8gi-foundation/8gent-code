import { afterAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { calibrationFileName, loadCalibration } from "../calibrate";
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
		const b = new LlamaServerBackend({ model: JUDGE_MODEL });
		expect(b.name).toBe("llamacpp");
		expect(b.model).toBe(JUDGE_MODEL);
		expect(loadCalibration(b.model, b.name)).not.toBeNull();
	});

	test("POSTs a raw one-token prompt to the loopback /completion, never following a redirect", async () => {
		const s = fakeServer();
		const res = await ask(new LlamaServerBackend({ model: JUDGE_MODEL, fetch: s.fetchImpl }));
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
		await ask(new LlamaServerBackend({ model: JUDGE_MODEL, fetch: s.fetchImpl, apiKey: "k-123" }));
		const h = s.calls.find((x) => x.url.endsWith("/completion"))?.init?.headers as Record<
			string,
			string
		>;
		expect(h.authorization).toBe("Bearer k-123");
		const t = fakeServer();
		await ask(new LlamaServerBackend({ model: JUDGE_MODEL, fetch: t.fetchImpl }));
		const h2 = t.calls.find((x) => x.url.endsWith("/completion"))?.init?.headers as Record<
			string,
			string
		>;
		expect(h2.authorization).toBeUndefined();
	});

	test("a server that cannot answer is Unavailable; an answer with no probabilities is an error", async () => {
		const down = new LlamaServerBackend({
			model: JUDGE_MODEL,
			fetch: async () => {
				throw new Error("ECONNREFUSED");
			},
		});
		await expect(ask(down)).rejects.toBeInstanceOf(DecideUnavailableError);
		const e500 = new LlamaServerBackend({
			model: JUDGE_MODEL,
			fetch: fakeServer({ completion: () => new Response("x", { status: 500 }) }).fetchImpl,
		});
		await expect(ask(e500)).rejects.toBeInstanceOf(DecideUnavailableError);
		const empty = new LlamaServerBackend({
			model: JUDGE_MODEL,
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

// #4965: the judge's name comes from the server 8gent started (its record, written from the chosen
// catalogue entry), so thresholds are looked up for exactly that model. A test-only name: no model
// is added to the catalogue here.
describe("the model name is the record's own, and so are the thresholds (#4965)", () => {
	const OTHER = "test-org/not-selene-judge:q4";
	const profile = (over: Record<string, unknown> = {}) => ({
		model: OTHER,
		backend: "llamacpp",
		fittedOn: "test",
		n: 2,
		temperature: 1,
		bias: 0,
		blockAbove: 0.91,
		escalateBand: [0.12, 0.91],
		heldOut: { recall: 1, falseBlock: 0, accuracy: 1, escalate: 0, method: "leave-one-out" },
		...over,
	});
	function calDir(withOther: boolean) {
		const d = home();
		const selene = loadCalibration(JUDGE_MODEL, "llamacpp");
		if (!selene) throw new Error("the shipped Selene llama.cpp profile is missing");
		writeFileSync(join(d, calibrationFileName("llamacpp", JUDGE_MODEL)), JSON.stringify(selene));
		if (withOther)
			writeFileSync(join(d, calibrationFileName("llamacpp", OTHER)), JSON.stringify(profile()));
		return d;
	}

	test("a non-Selene record with its own profile: probe, backend and verdicts carry its name, and its thresholds are its own", async () => {
		const cal = calDir(true);
		const env = envWith(record({ model: OTHER }));
		const s = fakeServer();
		const probe = await detectBackend({
			env,
			fetch: s.fetchImpl,
			llamacppLoader: null,
			calibrationDir: cal,
		});
		expect(probe).toMatchObject({ backend: "llamacpp", model: OTHER, url: LLAMA_URL });

		const d = createDecider({ env, fetch: s.fetchImpl, llamacppLoader: null, calibrationDir: cal });
		const b = await d.backend();
		expect(b).toBeInstanceOf(LlamaServerBackend);
		expect(b.model).toBe(OTHER);
		const res = await d.ask({
			state: "ls",
			questions: [{ id: "n", kind: "noul", prompt: "Destructive?" }],
		});
		expect(res.model).toBe(OTHER);

		// The gate keys thresholds on (backend.name, backend.model) (system-one-gate thresholdsFor).
		const got = loadCalibration(b.model, b.name, cal);
		const selene = loadCalibration(JUDGE_MODEL, "llamacpp", cal);
		expect(got?.model).toBe(OTHER);
		expect(got?.blockAbove).toBe(0.91);
		expect(got?.blockAbove).not.toBe(selene?.blockAbove);
		expect(got?.escalateBand).not.toEqual(selene?.escalateBand);
	});

	test("missing profile for that exact model: no judge at all, never Selene's thresholds", async () => {
		const cal = calDir(false);
		const env = { ...envWith(record({ model: OTHER })), EIGHT_S1_SHARED_JUDGE: "0" };
		expect(readLlamaRecord(env, cal)).toBeNull();
		const s = fakeServer();
		const probe = await detectBackend({
			env,
			fetch: s.fetchImpl,
			llamacppLoader: null,
			calibrationDir: cal,
		});
		expect(probe.backend).not.toBe("llamacpp");
		expect(probe.model).not.toBe(JUDGE_MODEL);
		// The server on the port is not even asked: the record is not trusted.
		expect(s.calls.some((c) => c.url.startsWith(LLAMA_URL))).toBe(false);
	});

	test("a profile filed under the right name but fitted for another model does not count", () => {
		const cal = calDir(false);
		writeFileSync(
			join(cal, calibrationFileName("llamacpp", OTHER)),
			JSON.stringify(profile({ model: JUDGE_MODEL })),
		);
		expect(readLlamaRecord(envWith(record({ model: OTHER })), cal)).toBeNull();
	});

	test("the shipped Selene record still reads, through the shipped profiles", () => {
		expect(readLlamaRecord(envWith(record()))?.model).toBe(JUDGE_MODEL);
	});
});
