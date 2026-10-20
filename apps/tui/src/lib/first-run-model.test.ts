import { describe, expect, test } from "bun:test";
import {
	autoSelectModel,
	listProviderModels,
	planAgentBuild,
	startupModelSeed,
} from "./model-selection";

/** A stub provider registry whose live list is whatever the test says. */
function stub(live: string[] | Error, recorded: string[] = []) {
	const asked: string[] = [];
	return {
		asked,
		isKnownProvider: (n: string) => n === "minimax",
		getProvider: () => ({ models: recorded }),
		discoverModels: async (n: string) => {
			asked.push(n);
			if (live instanceof Error) throw live;
			return live;
		},
	};
}

describe("startup model after --provider", () => {
	test("a model saved for another provider is dropped and the live list decides", async () => {
		const seed = startupModelSeed({
			cliProvider: "minimax",
			savedProvider: "openrouter",
			savedModel: "auto:free",
		});
		expect(seed).toBe("");

		const reg = stub(["stub-model-a", "stub-model-b"]);
		const available = await listProviderModels(reg, "minimax");
		expect(reg.asked).toEqual(["minimax"]);
		expect(available).toEqual(["stub-model-a", "stub-model-b"]);

		const picked = autoSelectModel({
			current: seed,
			currentProvider: "minimax",
			available,
			explicit: null,
		});
		expect(available).toContain(picked as string);
		expect(picked).not.toBe("auto:free");
	});

	test("a model saved for the same provider still wins", () => {
		expect(
			startupModelSeed({
				cliProvider: "minimax",
				savedProvider: "minimax",
				savedModel: "kept-model",
			}),
		).toBe("kept-model");
		expect(
			startupModelSeed({
				cliProvider: "minimax",
				cliModel: "asked-for",
				savedProvider: "openrouter",
				savedModel: "x",
			}),
		).toBe("asked-for");
	});

	test("the built-in MiniMax entry names no model", async () => {
		const { ProviderManager } = await import("../../../../packages/providers/index");
		const cfg = new ProviderManager("/nonexistent/providers.json").getProvider("minimax");
		expect(cfg.defaultModel).toBe("");
		expect(cfg.models).toEqual([]);
	});

	test("list unavailable: nothing is guessed, no request is built, the user is told to pick", async () => {
		const available = await listProviderModels(stub(new Error("offline")), "minimax");
		expect(available).toEqual([]);
		expect(
			autoSelectModel({ current: "", currentProvider: "minimax", available, explicit: null }),
		).toBeNull();

		let requests = 0;
		const plan = await planAgentBuild("minimax", "", async (m) => {
			requests++;
			return { model: m };
		});
		expect(requests).toBe(0);
		expect(plan.kind).toBe("wait");
		expect((plan as { notice: string }).notice).toContain("/model");
	});
});
