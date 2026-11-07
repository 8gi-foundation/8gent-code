/**
 * Naming rule (Termux report, 7 Nov): text a person reads says 8gent, never "the agent".
 * Covers the approval-card reasons and the system prompt's writing rule.
 */
import { describe, expect, test } from "bun:test";
import { COMMUNICATION_SEGMENT } from "./prompts/system-prompt";

const read = (rel: string) => Bun.file(new URL(rel, import.meta.url)).text();

describe("8gent names itself", () => {
	test("approval-card reasons say 8gent wants, not the agent wants", async () => {
		for (const f of [
			"./tools.ts",
			"./term-tools.ts",
			"../ai/tools.ts",
			"../permissions/index.ts",
			"../daemon/telegram-bridge.ts",
			"../orchestration/delegation-tools.ts",
		]) {
			const src = await read(f);
			expect(src).not.toMatch(/[Tt]he agent wants/);
			expect(src).toContain("8gent wants to");
		}
	});

	test("the writing rules tell the model to say 8gent", () => {
		expect(COMMUNICATION_SEGMENT).toContain('Never call yourself "the agent"');
	});
});
