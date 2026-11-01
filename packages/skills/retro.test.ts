/**
 * /retro ships with the product, so the command has to exist without the user
 * installing anything. A SKILL.md alone does not prove that: the file has to
 * parse, register a slash trigger, and resolve back to a skill with a prompt.
 * That is the chain the command palette walks, so it is the chain tested here.
 */
import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import { SkillManager } from "./index.js";

const BUNDLED = join(import.meta.dir);

async function bundled() {
	const manager = new SkillManager(BUNDLED);
	await manager.loadSkills();
	return manager;
}

const strip = (token: string) => token.replace(/^\//, "");

describe("/retro is a bundled command", () => {
	test("the skill loads from packages/skills", async () => {
		const skill = (await bundled()).getSkill("retro");
		expect(skill).toBeTruthy();
		expect(skill?.name).toBe("retro");
		expect((skill?.description ?? "").length).toBeGreaterThan(20);
	});

	test("it registers a slash trigger the palette can resolve", async () => {
		const manager = await bundled();
		const tokens = [...manager.getSkillSlashTriggers()].map(String);
		const retro = tokens.filter((t) => strip(t) === "retro");
		expect(retro.length).toBeGreaterThan(0);
		// The palette looks the skill back up by the token, so that must round-trip.
		for (const token of retro) {
			expect(manager.getSkill(strip(token))).toBeTruthy();
		}
	});

	test("the prompt carries the parts that make it a retro, not a summary", async () => {
		const prompt = (await bundled()).getSkill("retro")?.prompt ?? "";
		expect(prompt.length).toBeGreaterThan(500);
		// The interview, the table, and the cap are the three load-bearing pieces.
		expect(prompt).toContain("determinism table");
		expect(prompt.toLowerCase()).toContain("at most one");
		expect(prompt).toMatch(/hook/i);
		// It must not drift back into being a summary generator.
		expect(prompt).toContain("not a summary");
	});
});
