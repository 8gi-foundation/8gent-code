import { describe, expect, test } from "bun:test";
import { expandSkillSlashCommand, stripSkillNamespace } from "./skill-slash.js";

describe("skill slash expansion", () => {
	test("stripSkillNamespace removes only the skill: prefix", () => {
		expect(stripSkillNamespace("skill:voice")).toBe("voice");
		expect(stripSkillNamespace("SKILL:voice")).toBe("voice");
		expect(stripSkillNamespace("voice")).toBe("voice");
		expect(stripSkillNamespace("skills")).toBe("skills");
	});

	test("/skill:<name> expands to the same prompt as /<name> (#2932)", async () => {
		// boardroom is bundled in packages/skills, so this holds in any checkout.
		const direct = await expandSkillSlashCommand("/boardroom");
		expect(direct.startsWith("[SKILL: boardroom]")).toBeTrue();
		const namespaced = await expandSkillSlashCommand("/skill:boardroom");
		expect(namespaced).toBe(direct);
		// The alias that collides with the builtin kanban /board also works namespaced.
		const viaAlias = await expandSkillSlashCommand("/skill:board");
		expect(viaAlias).toBe(direct);
	});

	test("unknown slashes and plain text pass through untouched", async () => {
		expect(await expandSkillSlashCommand("/skill:definitely-not-real")).toBe(
			"/skill:definitely-not-real",
		);
		expect(await expandSkillSlashCommand("hello there")).toBe("hello there");
	});
});
