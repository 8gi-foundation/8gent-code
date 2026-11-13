/**
 * The PII gate covers the main loop (AI-SDK path), not only ProviderManager.chat().
 *
 * Drives the real Agent.chat() turn loop against a fake cloud endpoint, reached
 * by the provider's real hosted URL (api.minimax.io, openrouter.ai) through a
 * fetch spy, as cache-affinity-wiring.test.ts does. A turn carries a planted
 * name, email and phone in the user message, in the system prompt, and in a
 * tool result the fake model asks for. None may arrive raw; the reply comes back
 * restored. When the gate cannot run, nothing reaches the cloud at all.
 */

import { afterAll, beforeAll, describe, expect, spyOn, test } from "bun:test";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { rmRetry } from "../../tests/rm-retry";
import * as anonymizer from "../permissions/pii-anonymizer";

let Agent: typeof import("./agent").Agent;

const RAW = [
	"sarah.connor@example.com",
	"555-0182",
	"Sarah Connor",
	"dana.scully@fbi.example",
	"Dana Scully",
	"bob.marley@contoso.org",
	"123 4567",
	"Bob Marley",
];
const USER =
	"Email sarah.connor@example.com, call +1 (415) 555-0182, then read contacts.txt for Sarah Connor.";
const SYSTEM =
	"You are a test assistant. Escalations go to Dana Scully at dana.scully@fbi.example.";
const FILE = "Bob Marley, bob.marley@contoso.org, +353 87 123 4567\n";

/** Raw request bodies the fake cloud received, in order. */
const bodies: string[] = [];
const saved: Record<string, string | undefined> = {};
const ENV: Record<string, string> = {
	EIGHT_TOOL_CAPABILITY_GATE: "0",
	EIGHT_TEXT_TOOLS: "0",
	"8GENT_TWO_STAGE_COMPACT": "0",
	EIGHT_TURN_TIMEOUT_MS: "20000",
	EIGHT_KEY_BACKEND: "file",
	MINIMAX_API_KEY: "test-minimax-key",
	OPENROUTER_API_KEY: "test-openrouter-key",
	EIGHT_ALLOW_HOSTED: "1",
};
let home: string;
let repo: string;
let server: ReturnType<typeof Bun.serve>;
let fetchSpy: { mockRestore: () => void } | undefined;
let chainSpy: { mockRestore: () => void } | undefined;

function reply(model: string, message: Record<string, unknown>, finish: string): Response {
	return Response.json({
		id: "c1",
		object: "chat.completion",
		created: 0,
		model,
		choices: [{ index: 0, message: { role: "assistant", ...message }, finish_reason: finish }],
		usage: { prompt_tokens: 10, completion_tokens: 1, total_tokens: 11 },
	});
}

beforeAll(async () => {
	home = mkdtempSync(join(tmpdir(), "pii-sdk-home-"));
	repo = mkdtempSync(join(tmpdir(), "pii-sdk-repo-"));
	mkdirSync(join(home, ".8gent", "memory"), { recursive: true });
	writeFileSync(join(repo, "contacts.txt"), FILE);

	server = Bun.serve({
		port: 0,
		async fetch(req) {
			if (req.method !== "POST") return Response.json({ data: [] });
			const text = await req.text();
			bodies.push(text);
			const body = JSON.parse(text) as {
				model: string;
				messages: { role: string; content: unknown }[];
			};
			const hasToolResult = body.messages.some((m) => m.role === "tool");
			if (!hasToolResult) {
				return reply(
					body.model,
					{
						content: null,
						tool_calls: [
							{
								id: "call_1",
								type: "function",
								function: {
									name: "read_file",
									arguments: JSON.stringify({ path: "contacts.txt" }),
								},
							},
						],
					},
					"tool_calls",
				);
			}
			// Echo the pseudonym the model was shown for the user's email: the gate must restore it.
			const user = body.messages.find(
				(m) => m.role === "user" && String(m.content).includes("Email "),
			);
			const token = String(user?.content ?? "").match(/\[EMAIL_\d+\]/)?.[0] ?? "none";
			return reply(body.model, { content: `Will email ${token}.` }, "stop");
		},
	});

	const realFetch = globalThis.fetch;
	fetchSpy = spyOn(globalThis, "fetch").mockImplementation(((
		input: RequestInfo | URL,
		init?: RequestInit,
	) => {
		const url = new URL(input instanceof Request ? input.url : String(input));
		if (url.hostname === "api.minimax.io" || url.hostname === "openrouter.ai") {
			const path = url.pathname.replace(/^\/api/, "");
			return realFetch(`http://127.0.0.1:${server.port}${path}${url.search}`, init);
		}
		// Nothing else may answer: no real local model, no real network.
		return Promise.reject(new Error(`test blocks network to ${url.host}`));
	}) as typeof fetch);

	const chains = {
		text: {
			"MiniMax-M3": { models: [{ model: "MiniMax-M3", provider: "minimax" }] },
			"minimax/minimax-m2": { models: [{ model: "minimax/minimax-m2", provider: "openrouter" }] },
		},
		computer: {},
	};
	const { ModelFailover } = await import("../providers/failover");
	chainSpy = spyOn(
		ModelFailover.prototype as unknown as { loadChains: () => unknown },
		"loadChains",
	).mockReturnValue(chains);

	ENV.HOME = home;
	ENV.EIGHT_DATA_DIR = join(home, ".8gent");
	for (const [k, v] of Object.entries(ENV)) {
		saved[k] = process.env[k];
		process.env[k] = v;
	}
	({ Agent } = await import("./agent"));
});

afterAll(() => {
	fetchSpy?.mockRestore();
	chainSpy?.mockRestore();
	server.stop(true);
	for (const [k, v] of Object.entries(saved)) {
		if (v === undefined) delete process.env[k];
		else process.env[k] = v;
	}
	rmRetry(home);
	rmRetry(repo);
});

function agentFor(runtime: string, model: string) {
	return new Agent({
		model,
		runtime,
		workingDirectory: repo,
		systemPrompt: SYSTEM,
	} as ConstructorParameters<typeof import("./agent").Agent>[0]);
}

describe("PII gate on the AI-SDK path (main loop)", () => {
	for (const [runtime, model] of [
		["minimax", "MiniMax-M3"],
		["openrouter", "minimax/minimax-m2"],
	] as const) {
		test(`${runtime}: user text, system prompt and tool results leave pseudonymized; reply is restored`, async () => {
			const start = bodies.length;
			const out = await agentFor(runtime, model).chat(USER);
			const sent = bodies.slice(start);
			// Two model calls: the turn, then the turn with the tool result.
			expect(sent.length).toBeGreaterThanOrEqual(2);
			expect(sent.some((b) => b.includes('"role":"tool"'))).toBe(true);
			for (const b of sent) for (const raw of RAW) expect(b).not.toContain(raw);
			const all = sent.join("\n");
			expect(all).toMatch(/\[EMAIL_\d+\]/);
			expect(all).toMatch(/\[PHONE_\d+\]/);
			expect(all).toMatch(/\[PERSON_\d+\]/);
			// The person sees the real value, restored from the pseudonym the cloud saw.
			expect(out).toContain("sarah.connor@example.com");
		}, 60000);
	}

	test("gate failure blocks the send: the cloud receives nothing, raw or otherwise", async () => {
		const spy = spyOn(anonymizer, "anonymizeMessages").mockImplementation(() => {
			throw new Error("anonymizer down");
		});
		const start = bodies.length;
		try {
			await agentFor("minimax", "MiniMax-M3")
				.chat(USER)
				.catch(() => "");
		} finally {
			spy.mockRestore();
		}
		expect(bodies.slice(start)).toEqual([]);
	}, 60000);
});

describe("second detector plug-in point (#274)", () => {
	const body = JSON.stringify({
		model: "m",
		messages: [
			{ role: "system", content: "Talk to Sarah tomorrow." },
			{ role: "user", content: "Mail sarah.connor@example.com" },
		],
	});

	test("values it finds are masked with the same map, after the patterns ran", async () => {
		const { gateBody, setPiiSecondDetector } = await import("../ai/pii-gated-fetch");
		let seen: string[] = [];
		setPiiSecondDetector(async (texts) => {
			seen = texts;
			return ["Sarah"];
		});
		try {
			const out = await gateBody(body);
			// The detector saw pseudonymized text, never the raw email.
			expect(seen.join("\n")).not.toContain("sarah.connor@example.com");
			expect(out.body).not.toContain("Sarah");
			expect(out.body).toContain("[PII_1]");
			expect(out.map.get("[PII_1]")).toBe("Sarah");
		} finally {
			setPiiSecondDetector(null);
		}
	});

	test("a detector that fails or times out blocks the send", async () => {
		const { piiGatedFetch, setPiiSecondDetector } = await import("../ai/pii-gated-fetch");
		let sent = 0;
		const gated = piiGatedFetch((async () => {
			sent++;
			return Response.json({});
		}) as unknown as typeof fetch);
		setPiiSecondDetector(() => Promise.reject(new Error("classifier timed out")));
		try {
			await expect(
				gated("https://api.minimax.io/v1/chat/completions", { method: "POST", body }),
			).rejects.toThrow(/fail-closed/);
			expect(sent).toBe(0);
		} finally {
			setPiiSecondDetector(null);
		}
	});
});

test("a streamed reply is restored, a pseudonym split across chunks included", async () => {
	const { piiGatedFetch } = await import("../ai/pii-gated-fetch");
	let sentBody = "";
	const ev = (o: unknown) => `data: ${JSON.stringify(o)}\n\n`;
	const gated = piiGatedFetch((async (_u: string, init: RequestInit) => {
		sentBody = String(init.body);
		const chunks = [
			ev({ choices: [{ index: 0, delta: { content: "Writing to [EMA" }, finish_reason: null }] }),
			ev({ choices: [{ index: 0, delta: { content: "IL_1] now" }, finish_reason: null }] }),
			ev({ choices: [{ index: 0, delta: {}, finish_reason: "stop" }] }),
			"data: [DONE]\n\n",
		];
		const enc = new TextEncoder();
		const stream = new ReadableStream({
			start(c) {
				for (const x of chunks) c.enqueue(enc.encode(x));
				c.close();
			},
		});
		return new Response(stream, { headers: { "content-type": "text/event-stream" } });
	}) as unknown as typeof fetch);
	const res = await gated("https://openrouter.ai/api/v1/chat/completions", {
		method: "POST",
		body: JSON.stringify({
			model: "m",
			stream: true,
			messages: [{ role: "user", content: "mail sarah.connor@example.com" }],
		}),
	});
	expect(sentBody).not.toContain("sarah.connor@example.com");
	const text = await res.text();
	const content = text
		.split("\n")
		.filter((l) => l.startsWith("data: {"))
		.map((l) => JSON.parse(l.slice(6)).choices[0].delta.content ?? "")
		.join("");
	expect(content).toBe("Writing to sarah.connor@example.com now");
});
