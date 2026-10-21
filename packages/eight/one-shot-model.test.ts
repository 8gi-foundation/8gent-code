import { describe, expect, test } from "bun:test";
import { modelForOneShot } from "./run";

describe("modelForOneShot", () => {
	test("an explicit model wins", async () => {
		expect(await modelForOneShot("minimax", " m-x ", async () => ["other"])).toBe("m-x");
	});
	test("a cloud provider takes the first live model, never the openrouter alias", async () => {
		expect(await modelForOneShot("minimax", undefined, async () => ["live-1", "live-2"])).toBe(
			"live-1",
		);
	});
	test("an unreachable list gives empty, not a guess", async () => {
		expect(
			await modelForOneShot("minimax", undefined, async () => {
				throw new Error("down");
			}),
		).toBe("");
		expect(await modelForOneShot("minimax", undefined, async () => [])).toBe("");
	});
});

describe("no --model on a hosted provider (regression)", () => {
	test("picks the first model of a mocked OpenAI-shaped list, no name typed", async () => {
		const { modelForOneShotWithReason } = await import("./run");
		const r = await modelForOneShotWithReason("minimax", undefined, async () => [
			"fake-model-a",
			"fake-model-b",
		]);
		expect(r).toEqual({ model: "fake-model-a" });
	});
	test("keeps the error when the list fails", async () => {
		const { modelForOneShotWithReason } = await import("./run");
		const e = new Error("Model discovery failed for u: 401 x");
		const r = await modelForOneShotWithReason("minimax", undefined, async () => {
			throw e;
		});
		expect(r).toEqual({ model: "", error: e });
	});
});
