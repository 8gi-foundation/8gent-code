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
