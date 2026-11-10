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

	test("no approval card title or reason has the word agent in it", async () => {
		const files = [
			"./tools.ts",
			"./term-tools.ts",
			"../ai/tools.ts",
			"../permissions/index.ts",
			"../daemon/telegram-bridge.ts",
			"../orchestration/delegation-tools.ts",
		];
		let cards = 0;
		for (const f of files) {
			const src = await read(f);
			for (const m of src.matchAll(/requestPermission\(([\s\S]*?)\n\t*\);?/g)) {
				cards++;
				// title and reason are the string literals in the call; the command and options are identifiers
				const literals = [...m[1].matchAll(/"((?:[^"\\]|\\.)*)"/g)].map((l) => l[1]);
				for (const t of literals) expect(t).not.toMatch(/agent/i);
			}
		}
		expect(cards).toBeGreaterThan(5);
	});

	test("the Telegram menus and first-run line say 8gent, not the agent", async () => {
		for (const f of ["../telegram/index.ts", "./agent.ts"]) {
			const code = (await read(f)).split("\n").filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l)).join("\n");
			expect(code).not.toMatch(/[Tt]he agent (will|has|can)|chat with the agent/);
		}
	});

	test("the writing rules tell the model to say 8gent", () => {
		expect(COMMUNICATION_SEGMENT).toContain('Never call yourself "the agent"');
	});
});
