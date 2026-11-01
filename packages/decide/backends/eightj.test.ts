/**
 * 8J backend through the production path: a real HTTP stub of serve_8j.py on loopback, the real
 * createDecider (explicit and auto probe), and bashGuard. Covers the card's wire shape, the
 * fitted-lines verdicts, and fail-closed on 5xx, timeout, a dead server and a non-loopback URL.
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { BASH_GUARD_QUESTION, bashGuard } from "../guard";
import { createDecider } from "../index";
import { detectBackend } from "../probe";
import type { SystemOneRequest } from "../types";
import { EIGHTJ_URL_ENV, fromCardAnswer, isLoopbackUrl, toCardBody } from "./eightj";

const MODEL = "8j-stub-run";
/** pYes the stub answers per command; anything else gets 0.5. */
const SCORES: Record<string, number> = {
	"git status": 0.01,
	"make build": 0.3,
	"scp notes.txt host:/tmp/": 0.9,
};
type Mode = "ok" | "error" | "hang" | "bad";
let mode: Mode = "ok";
let lastBody: unknown = null;

/** The command inside guardState's fence: the JSON line between the two markers. */
function commandOf(state: string): string {
	const lines = state.split("\n");
	const open = lines.findIndex((l) => l.startsWith("<<<CMD-"));
	return JSON.parse(lines[open + 1]) as string;
}

let server: ReturnType<typeof Bun.serve>;
let url: string;

beforeAll(() => {
	server = Bun.serve({
		hostname: "127.0.0.1",
		port: 0,
		async fetch(req) {
			const path = new URL(req.url).pathname;
			if (path === "/health") return Response.json({ ok: true, model: MODEL });
			if (path !== "/v1/systemone" || req.method !== "POST")
				return new Response("no", { status: 404 });
			if (mode === "error")
				return Response.json({ error: { type: "model_error" } }, { status: 500 });
			if (mode === "hang") await Bun.sleep(2_000);
			const body = (await req.json()) as {
				state: string;
				questions: Record<string, { type: string }>;
			};
			lastBody = body;
			const answers: Record<string, unknown> = {};
			for (const [id, q] of Object.entries(body.questions)) {
				if (mode === "bad") answers[id] = { type: "noul", noul: Number.NaN };
				else answers[id] = { type: q.type, noul: SCORES[commandOf(body.state)] ?? 0.5 };
			}
			return Response.json({ model: MODEL, answers, latency_ms: 1 });
		},
	});
	url = `http://127.0.0.1:${server.port}`;
});

afterAll(() => server.stop(true));

/** The fitted-lines shape: allow below 0.1, block above 0.6, a person between. */
const LINES = { blockAbove: 0.6, escalateBand: [0.1, 0.6] as [number, number] };

function decider(env: Record<string, string | undefined>) {
	return createDecider({ backend: "8j", env, cacheSize: 0 });
}

describe("8j wire shape", () => {
	test("card body: noul, choice keys, score levels", () => {
		const req: SystemOneRequest = {
			state: "s",
			questions: [
				{ id: "a", kind: "noul", prompt: "p" },
				{ id: "b", kind: "choice", prompt: "p", options: ["x", "y", "x"] },
				{ id: "c", kind: "score", prompt: "p", levels: ["low", "high"] },
			],
		};
		expect(toCardBody(req)).toEqual({
			state: "s",
			questions: {
				a: { type: "noul", instructions: "p" },
				b: {
					type: "choice",
					instructions: "p",
					criteria: { "x (0)": null, y: null, "x (2)": null },
				},
				c: { type: "score", instructions: "p", criteria: ["low", "high"] },
			},
		});
	});

	test("answers: noul, choice by key, score by level; unusable ones throw", () => {
		expect(fromCardAnswer({ id: "a", kind: "noul", prompt: "p" }, { noul: 0.25 })).toEqual([
			0.25, 0.75,
		]);
		const choice = { id: "b", kind: "choice" as const, prompt: "p", options: ["x", "y"] };
		expect(fromCardAnswer(choice, { probabilities: { x: 0.2, y: 0.8 } })).toEqual([0.2, 0.8]);
		const score = { id: "c", kind: "score" as const, prompt: "p", levels: ["l", "h"] };
		expect(fromCardAnswer(score, { probabilities: [0.4, 0.6] })).toEqual([0.4, 0.6]);
		expect(() => fromCardAnswer({ id: "a", kind: "noul", prompt: "p" }, { noul: 1.5 })).toThrow();
		expect(() => fromCardAnswer(score, { probabilities: [1] })).toThrow();
	});

	test("loopback only", () => {
		expect(isLoopbackUrl("http://127.0.0.1:8086")).toBe(true);
		expect(isLoopbackUrl("http://localhost:8086")).toBe(true);
		expect(isLoopbackUrl("http://[::1]:8086")).toBe(true);
		expect(isLoopbackUrl("http://10.0.0.5:8086")).toBe(false);
		expect(isLoopbackUrl("http://127.0.0.1.example.com")).toBe(false);
		expect(isLoopbackUrl("file:///tmp/x")).toBe(false);
	});
});

describe("bashGuard on the 8j backend", () => {
	test("the stub sees guard.ts's question and fenced state", async () => {
		mode = "ok";
		await bashGuard("git status", decider({ [EIGHTJ_URL_ENV]: url }), LINES);
		const body = lastBody as { state: string; questions: Record<string, { instructions: string }> };
		expect(commandOf(body.state)).toBe("git status");
		expect(Object.values(body.questions)[0].instructions).toBe(BASH_GUARD_QUESTION);
	});

	test("allow, escalate and block follow the lines", async () => {
		mode = "ok";
		const d = decider({ [EIGHTJ_URL_ENV]: url });
		const allow = await bashGuard("git status", d, LINES);
		expect(allow).toMatchObject({ verdict: "allow", backend: "8j", model: MODEL, pYes: 0.01 });
		expect((await bashGuard("make build", d, LINES)).verdict).toBe("escalate");
		expect((await bashGuard("scp notes.txt host:/tmp/", d, LINES)).verdict).toBe("block");
	});

	test("a 500 is never an allow", async () => {
		mode = "error";
		const r = await bashGuard("git status", decider({ [EIGHTJ_URL_ENV]: url }), LINES);
		expect(r.verdict).toBe("block");
		expect(r.backend).toBe("unavailable");
	});

	test("a timeout is never an allow", async () => {
		mode = "hang";
		const env = { [EIGHTJ_URL_ENV]: url, EIGHT_8J_TIMEOUT_MS: "150" };
		const r = await bashGuard("git status", decider(env), LINES);
		expect(r.verdict).toBe("block");
		expect(r.reason).toContain("8j unreachable");
	});

	test("an answer with no valid probability is never an allow", async () => {
		mode = "bad";
		const r = await bashGuard("git status", decider({ [EIGHTJ_URL_ENV]: url }), LINES);
		expect(r.verdict).toBe("block");
	});

	test("a dead server is never an allow", async () => {
		const r = await bashGuard(
			"git status",
			decider({ [EIGHTJ_URL_ENV]: "http://127.0.0.1:9" }),
			LINES,
		);
		expect(r.verdict).toBe("block");
	});

	test("a non-loopback URL is refused before anything is sent", async () => {
		const r = await bashGuard(
			"git status",
			decider({ [EIGHTJ_URL_ENV]: "http://10.0.0.5:8086" }),
			LINES,
		);
		expect(r.verdict).toBe("block");
		expect(r.reason).toContain("loopback");
	});
});

describe("auto probe", () => {
	test("EIGHT_8J_URL selects 8j ahead of every other judge", async () => {
		mode = "ok";
		const d = createDecider({ env: { [EIGHTJ_URL_ENV]: url }, llamacppLoader: null, cacheSize: 0 });
		const b = await d.backend();
		expect(b.name).toBe("8j");
		expect(b.model).toBe(MODEL);
		expect((await bashGuard("git status", d, LINES)).verdict).toBe("allow");
	});

	test("selected but down: no other judge is used", async () => {
		const asked: string[] = [];
		// Every other server would answer: an Ollama with a model, a laya with a health route.
		const fetchAll = async (input: string) => {
			asked.push(input);
			if (input.startsWith("http://127.0.0.1:9/")) throw new TypeError("connect refused");
			if (input.endsWith("/api/tags"))
				return Response.json({ models: [{ name: "judge:1b", size: 1 }] });
			return Response.json({ ok: true });
		};
		const probe = await detectBackend({
			env: { [EIGHTJ_URL_ENV]: "http://127.0.0.1:9" },
			fetch: fetchAll,
			llamacppLoader: null,
		});
		expect(probe.backend).toBe("none");
		expect(probe.notes.join(" ")).toContain("8j was selected");
		expect(asked).toEqual(["http://127.0.0.1:9/health"]);
	});
});
