import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { deriveProviders } from "../../apps/tui/src/lib/activity-rail-derivation";
import { checkModelSwitch } from "../../apps/tui/src/lib/model-selection";
import { routeOnScreen } from "../../apps/tui/src/lib/model-truth";
import { providerRouteNotice } from "../eight/run";
import { callLocalModelWithReroute, chooseRerouteModel, isHashNamedModel } from "./model-reroute";

const HASH = "c97eb11d70b1acdc88af01eef566c1fe4f7fbe93eb1afc06871132f293ff425a";

let ollamaHits = 0;
let minimaxHits = 0;
let minimaxMode: "ok" | "fail" = "ok";
let ollama: ReturnType<typeof Bun.serve>;
let minimax: ReturnType<typeof Bun.serve>;
const savedEnv = process.env.OLLAMA_BASE_URL;

beforeAll(() => {
	ollama = Bun.serve({
		port: 0,
		fetch() {
			ollamaHits++;
			return Response.json({ models: [{ name: `llamacpp:${HASH}` }, { name: "qwen3:14b" }] });
		},
	});
	minimax = Bun.serve({
		port: 0,
		fetch(req) {
			minimaxHits++;
			if (minimaxMode === "fail") {
				return new Response("model MiniMax-M2.7 not found for this account", { status: 404 });
			}
			return Response.json({ answer: "from minimax", url: new URL(req.url).pathname });
		},
	});
	process.env.OLLAMA_BASE_URL = `http://127.0.0.1:${ollama.port}`;
});

afterAll(() => {
	ollama.stop(true);
	minimax.stop(true);
	// Assigning undefined would store the string "undefined" and poison later files.
	if (savedEnv === undefined) Reflect.deleteProperty(process.env, "OLLAMA_BASE_URL");
	else process.env.OLLAMA_BASE_URL = savedEnv;
});

async function callMinimax(provider: string, model: string): Promise<string> {
	const res = await fetch(`http://127.0.0.1:${minimax.port}/chat`, { method: "POST" });
	if (!res.ok) throw new Error(`${provider} chat completions ${res.status}: ${await res.text()}`);
	return ((await res.json()) as { answer: string }).answer;
}

describe("a cloud provider's model is never checked against Ollama", () => {
	it("a minimax turn goes to the MiniMax endpoint and never queries Ollama", async () => {
		minimaxMode = "ok";
		ollamaHits = 0;
		minimaxHits = 0;
		const out = await callLocalModelWithReroute({
			provider: "minimax",
			model: "MiniMax-M2.7",
			run: callMinimax,
		});
		expect(out).toMatchObject({
			ok: true,
			value: "from minimax",
			usedProvider: "minimax",
			rerouted: false,
		});
		expect(minimaxHits).toBe(1);
		expect(ollamaHits).toBe(0);
	});

	it("a failing MiniMax endpoint returns the provider's own error, no Ollama request, with the live list", async () => {
		minimaxMode = "fail";
		ollamaHits = 0;
		minimaxHits = 0;
		const out = await callLocalModelWithReroute({
			provider: "minimax",
			model: "MiniMax-M2.7",
			run: callMinimax,
			liveModels: async () => ["MiniMax-M2", "MiniMax-M2.5"],
		});
		expect(out.ok).toBe(false);
		if (out.ok) return;
		expect(out.message).toContain("model MiniMax-M2.7 not found for this account");
		expect(out.message).toContain("MiniMax-M2, MiniMax-M2.5");
		expect(out.message).not.toContain("not installed");
		expect(minimaxHits).toBe(1);
		expect(ollamaHits).toBe(0);
	});
});

describe("one local set", () => {
	it("llama-server is local, minimax is not", async () => {
		const { isLocalProvider } = await import("./local-providers");
		expect(isLocalProvider("llama-server")).toBe(true);
		expect(isLocalProvider("minimax")).toBe(false);
	});
});

describe("a local fallback is announced and never a bare hash", () => {
	it("a missing local model reroutes within Ollama and says what, who, and why", async () => {
		let calls = 0;
		const notices: string[] = [];
		const out = await callLocalModelWithReroute({
			provider: "ollama",
			model: "qwen3.6:27b",
			run: async (_p, m) => {
				calls++;
				if (calls === 1)
					throw new Error("ollama chat completions 404: model 'qwen3.6:27b' not found");
				return m;
			},
			detect: async () => [
				{ provider: "ollama", model: `llamacpp:${HASH}`, score: 30 },
				{ provider: "ollama", model: "qwen3:14b", score: 14 },
			],
			onReroute: (missing, chosen) =>
				notices.push(providerRouteNotice(missing, chosen.provider, chosen.model, "missing")),
		});
		expect(out).toMatchObject({ ok: true, value: "qwen3:14b", rerouted: true });
		expect(notices).toEqual([
			"Asked for qwen3.6:27b; Ollama qwen3:14b is answering instead, because it is not installed locally.",
		]);
	});

	it("a hash-named Ollama model is never chosen as a fallback", () => {
		expect(isHashNamedModel(`llamacpp:${HASH}`)).toBe(true);
		expect(isHashNamedModel("qwen3:14b")).toBe(false);
		expect(
			chooseRerouteModel([{ provider: "ollama", model: `llamacpp:${HASH}`, score: 99 }], "x"),
		).toBeNull();
	});

	it("when only a hash model could answer, the line says an unnamed local model and the short hash", () => {
		expect(providerRouteNotice("MiniMax-M2.7", "ollama", `llamacpp:${HASH}`)).toBe(
			"Asked for MiniMax-M2.7; Ollama an unnamed local model (c97eb11d70b1) is answering instead, because it did not answer.",
		);
	});
});

describe("the panel shows what answered", () => {
	it("names the provider and model that answered, with the asked one noted", () => {
		const shown = routeOnScreen({
			asked: "MiniMax-M2.7",
			askedProvider: "minimax",
			built: "MiniMax-M2.7",
			live: "MiniMax-M2.7",
			routed: { model: "qwen3:14b", provider: "ollama" },
		});
		expect(shown).toMatchObject({ ran: "qwen3:14b", provider: "ollama", asked: "MiniMax-M2.7" });
		const rows = deriveProviders({
			primary: { name: `${shown.provider}:${shown.ran}`, asked: shown.asked },
			fallback: null,
			offline: null,
		});
		expect(JSON.stringify(rows)).toContain("ollama");
		expect(JSON.stringify(rows)).toContain("qwen3:14b");
		expect(JSON.stringify(rows)).toContain("MiniMax-M2.7");
	});

	it("with no reroute the panel names the chosen cloud provider", () => {
		const shown = routeOnScreen({
			asked: "MiniMax-M2.7",
			askedProvider: "minimax",
			built: "MiniMax-M2.7",
			live: "MiniMax-M2.7",
		});
		expect(shown).toEqual({ ran: "MiniMax-M2.7", provider: "minimax" });
	});
});

describe("/model on a cloud provider checks the provider's live list", () => {
	const reader = (live: string[]) => ({
		isKnownProvider: () => true,
		getProvider: () => ({ models: [] }) as never,
		discoverModels: async () => live,
	});
	const isLocal = (p: string) => p === "ollama";
	it("refuses a model the live list lacks, and shows the list", async () => {
		const v = await checkModelSwitch(
			reader(["MiniMax-M2"]) as never,
			"minimax",
			"MiniMax-M2.7",
			isLocal,
		);
		expect(v.ok).toBe(false);
		if (!v.ok) expect(v.message).toContain("MiniMax-M2");
	});
	it("fails open with a notice when the live fetch fails", async () => {
		const down = {
			isKnownProvider: () => true,
			getProvider: () => ({ models: ["declared-only"] }) as never,
			discoverModels: async () => {
				throw new Error("offline");
			},
		};
		const v = await checkModelSwitch(down as never, "minimax", "MiniMax-M2.7", isLocal);
		expect(v.ok).toBe(true);
		if (v.ok) expect(v.notice).toContain("Could not fetch minimax");
	});
	it("accepts a listed model, and a local one without asking", async () => {
		expect(
			(
				await checkModelSwitch(
					reader(["MiniMax-M2.7"]) as never,
					"minimax",
					"MiniMax-M2.7",
					isLocal,
				)
			).ok,
		).toBe(true);
		expect((await checkModelSwitch(reader([]) as never, "ollama", "anything", isLocal)).ok).toBe(
			true,
		);
	});
});
