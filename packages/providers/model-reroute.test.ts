import { describe, expect, it } from "bun:test";
import {
	type InstalledModel,
	callLocalModelWithReroute,
	chooseRerouteModel,
	isModelNotFoundError,
	noModelAvailableMessage,
} from "./model-reroute";

// The exact string the iOS app received in the incident. text-tool-endpoint.ts
// throws this when the daemon is pointed at a model Ollama does not have.
const INCIDENT_404 = "ollama chat completions 404: model 'qwen3.6:27b' not found";

// Only these two are actually installed on the incident host.
const INSTALLED: InstalledModel[] = [
	{ provider: "ollama", model: "qwen2.5vl:7b", score: 7 },
	{ provider: "ollama", model: "llama3.2:3b", score: 3 },
];

describe("isModelNotFoundError", () => {
	it("recognises the incident 404 string", () => {
		expect(isModelNotFoundError(new Error(INCIDENT_404))).toBe(true);
	});

	it("recognises native ollama 'not found' bodies", () => {
		expect(
			isModelNotFoundError(new Error("model 'qwen3.6:27b' not found, try pulling it first")),
		).toBe(true);
	});

	it("does NOT treat a server-down / reachability error as model-not-found", () => {
		expect(isModelNotFoundError(new Error("fetch failed"))).toBe(false);
		expect(isModelNotFoundError(new Error("connect ECONNREFUSED 127.0.0.1:11434"))).toBe(false);
	});
});

describe("chooseRerouteModel", () => {
	it("picks the highest-scoring installed model and never the missing one", () => {
		const chosen = chooseRerouteModel(INSTALLED, "qwen3.6:27b");
		expect(chosen?.model).toBe("qwen2.5vl:7b");
	});

	it("honours a preferred (failover-chain) model when it is installed", () => {
		const chosen = chooseRerouteModel(INSTALLED, "qwen3.6:27b", ["llama3.2:3b"]);
		expect(chosen?.model).toBe("llama3.2:3b");
	});

	it("returns null when nothing usable is installed", () => {
		expect(chooseRerouteModel([], "qwen3.6:27b")).toBeNull();
		// The only installed model is the one that just failed.
		expect(
			chooseRerouteModel([{ provider: "ollama", model: "qwen3.6:27b", score: 27 }], "qwen3.6:27b"),
		).toBeNull();
	});
});

describe("callLocalModelWithReroute", () => {
	it("reroutes to an available model instead of surfacing the raw 404", async () => {
		const calls: Array<{ provider: string; model: string }> = [];
		const rerouteLog: Array<{ missing: string; chosen: string }> = [];

		// First call (the configured, uninstalled model) 404s exactly as in the
		// incident; the retry on an installed model succeeds.
		const run = async (provider: string, model: string) => {
			calls.push({ provider, model });
			if (model === "qwen3.6:27b") throw new Error(INCIDENT_404);
			return `answer from ${model}`;
		};

		const outcome = await callLocalModelWithReroute({
			provider: "ollama",
			model: "qwen3.6:27b",
			run,
			detect: async () => INSTALLED,
			hasCloudKey: () => false,
			onReroute: (missing, chosen) => {
				rerouteLog.push({ missing, chosen: chosen.model });
			},
		});

		// No raw 404 escaped: we got a clean success on a real, installed model.
		expect(outcome.ok).toBe(true);
		if (outcome.ok) {
			expect(outcome.rerouted).toBe(true);
			expect(outcome.usedModel).toBe("qwen2.5vl:7b");
			expect(outcome.value).toBe("answer from qwen2.5vl:7b");
		}
		// Attempted the dead model once, then the rerouted model once.
		expect(calls).toEqual([
			{ provider: "ollama", model: "qwen3.6:27b" },
			{ provider: "ollama", model: "qwen2.5vl:7b" },
		]);
		expect(rerouteLog.length).toBe(1);
		expect(rerouteLog[0]?.missing).toBe("qwen3.6:27b");
		expect(rerouteLog[0]?.chosen).toBe("qwen2.5vl:7b");
	});

	it("returns a clean human message (no raw 404) when nothing is installed", async () => {
		const outcome = await callLocalModelWithReroute({
			provider: "ollama",
			model: "qwen3.6:27b",
			run: async () => {
				throw new Error(INCIDENT_404);
			},
			detect: async () => [],
			hasCloudKey: () => false,
		});

		expect(outcome.ok).toBe(false);
		if (!outcome.ok) {
			expect(outcome.message).not.toContain("404");
			expect(outcome.message.toLowerCase()).toContain("ollama pull");
			expect(outcome.message).toContain("add a cloud provider key");
		}
	});

	it("rethrows non-model errors (reachability) so existing handling applies", async () => {
		await expect(
			callLocalModelWithReroute({
				provider: "ollama",
				model: "qwen3.6:27b",
				run: async () => {
					throw new Error("fetch failed");
				},
				detect: async () => INSTALLED,
				hasCloudKey: () => false,
			}),
		).rejects.toThrow("fetch failed");
	});

	it("only reroutes once: a second failure is not swallowed", async () => {
		let n = 0;
		await expect(
			callLocalModelWithReroute({
				provider: "ollama",
				model: "qwen3.6:27b",
				run: async () => {
					n++;
					throw new Error(INCIDENT_404);
				},
				detect: async () => INSTALLED,
				hasCloudKey: () => false,
			}),
		).rejects.toThrow(INCIDENT_404);
		expect(n).toBe(2); // original + one reroute attempt, then it gives up
	});
});

describe("noModelAvailableMessage", () => {
	it("mentions the cloud option when a cloud key is present", () => {
		expect(noModelAvailableMessage("qwen3.6:27b", true)).toContain("cloud model");
	});
});

// ── Law 2 (issue #2747): only tool-capable models do tool-work ──────────────

import { resolveToolCapableModel } from "./model-reroute";

// The incident pair: gemma (bigger, 400s on tools) and ornith (accepts tools).
const GEMMA = "gemma-4-12b-coder-fable5-composer2.5-v1";
const INCIDENT_INSTALLED: InstalledModel[] = [
	{ provider: "lmstudio", model: GEMMA, score: 12 },
	{ provider: "lmstudio", model: "ornith-1.0-9b", score: 9 },
];

function probeFor(capabilities: Record<string, "native" | "none" | "unknown">) {
	return async (_provider: string, model: string) => capabilities[model] ?? "unknown";
}

describe("resolveToolCapableModel (Law 2)", () => {
	it("does NOT select a model that 400s a tools request for an agentic turn", async () => {
		const resolution = await resolveToolCapableModel({
			provider: "lmstudio",
			model: GEMMA,
			probe: probeFor({ [GEMMA]: "none", "ornith-1.0-9b": "native" }),
			detect: async () => INCIDENT_INSTALLED,
		});
		expect(resolution.switched).toBe(true);
		expect(resolution.model).toBe("ornith-1.0-9b");
		expect(resolution.model).not.toBe(GEMMA);
	});

	it("keeps a tool-capable pinned model untouched", async () => {
		const resolution = await resolveToolCapableModel({
			provider: "lmstudio",
			model: "ornith-1.0-9b",
			probe: probeFor({ "ornith-1.0-9b": "native" }),
			detect: async () => INCIDENT_INSTALLED,
		});
		expect(resolution.switched).toBe(false);
		expect(resolution.model).toBe("ornith-1.0-9b");
	});

	it("honours the operator's preferred pin when switching", async () => {
		const installed: InstalledModel[] = [
			...INCIDENT_INSTALLED,
			{ provider: "ollama", model: "qwen3:14b", score: 14 },
		];
		const resolution = await resolveToolCapableModel({
			provider: "lmstudio",
			model: GEMMA,
			prefer: ["ornith-1.0-9b"],
			probe: probeFor({ [GEMMA]: "none", "ornith-1.0-9b": "native", "qwen3:14b": "native" }),
			detect: async () => installed,
		});
		// qwen3:14b scores higher, but the operator pinned ornith.
		expect(resolution.model).toBe("ornith-1.0-9b");
	});

	it("never demotes on an 'unknown' probe (endpoint unreachable)", async () => {
		const resolution = await resolveToolCapableModel({
			provider: "lmstudio",
			model: GEMMA,
			probe: probeFor({}),
			detect: async () => INCIDENT_INSTALLED,
		});
		expect(resolution.switched).toBe(false);
		expect(resolution.model).toBe(GEMMA);
	});

	it("keeps the pin when no other candidate is verifiably tool-capable", async () => {
		const resolution = await resolveToolCapableModel({
			provider: "lmstudio",
			model: GEMMA,
			probe: probeFor({ [GEMMA]: "none", "ornith-1.0-9b": "none" }),
			detect: async () => INCIDENT_INSTALLED,
		});
		expect(resolution.switched).toBe(false);
		expect(resolution.model).toBe(GEMMA);
	});
});

describe("chooseRerouteModel with tool capability (Law 2)", () => {
	it("skips a model flagged as tool-incapable even when it scores highest", () => {
		const installed: InstalledModel[] = [
			{ provider: "lmstudio", model: GEMMA, score: 12, toolCapable: false },
			{ provider: "lmstudio", model: "ornith-1.0-9b", score: 9, toolCapable: true },
		];
		const chosen = chooseRerouteModel(installed, "qwen3.6:27b");
		expect(chosen?.model).toBe("ornith-1.0-9b");
	});
});

describe("callLocalModelWithReroute with a pinned provider (#3746)", () => {
	// Installed on other local providers only: a reroute would leave ollama.
	const ELSEWHERE: InstalledModel[] = [
		{ provider: "lmstudio", model: "lm-model", score: 9 },
		{ provider: "apple-foundation", model: "apple-foundationmodel", score: 3 },
	];

	it("never reroutes to another provider; ends with the pinned message", async () => {
		const calls: string[] = [];
		const rerouted: string[] = [];
		const outcome = await callLocalModelWithReroute({
			provider: "ollama",
			model: "qwen3.6:27b",
			run: async (provider, model) => {
				calls.push(`${provider}/${model}`);
				throw new Error(INCIDENT_404);
			},
			detect: async () => ELSEWHERE,
			hasCloudKey: () => false,
			pinned: true,
			pinnedMessage: (model, error) => `PINNED ${model}: ${error}`,
			onReroute: (_m, chosen) => rerouted.push(chosen.provider),
		});
		expect(calls).toEqual(["ollama/qwen3.6:27b"]);
		expect(rerouted).toEqual([]);
		expect(outcome.ok).toBe(false);
		if (!outcome.ok) expect(outcome.message).toBe(`PINNED qwen3.6:27b: ${INCIDENT_404}`);
	});

	it("still reroutes within the pinned provider", async () => {
		const outcome = await callLocalModelWithReroute({
			provider: "ollama",
			model: "qwen3.6:27b",
			run: async (_provider, model) => {
				if (model === "qwen3.6:27b") throw new Error(INCIDENT_404);
				return `answer from ${model}`;
			},
			detect: async () => [...ELSEWHERE, ...INSTALLED],
			hasCloudKey: () => false,
			pinned: true,
		});
		expect(outcome.ok).toBe(true);
		if (outcome.ok) expect(outcome.usedProvider).toBe("ollama");
	});

	it("un-pinned keeps today's reroute to another local provider", async () => {
		const outcome = await callLocalModelWithReroute({
			provider: "ollama",
			model: "qwen3.6:27b",
			run: async (_provider, model) => {
				if (model === "qwen3.6:27b") throw new Error(INCIDENT_404);
				return `answer from ${model}`;
			},
			detect: async () => ELSEWHERE,
			hasCloudKey: () => false,
		});
		expect(outcome.ok).toBe(true);
		if (outcome.ok) expect(outcome.usedProvider).toBe("lmstudio");
	});
});
