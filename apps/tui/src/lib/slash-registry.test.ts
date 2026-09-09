import { describe, expect, test } from "bun:test";
import {
	type SlashRegistryEntry,
	formatSlashCollisionLine,
	getBuiltInSlashCommands,
	getSkillSummary,
	getSlashRegistry,
	mergeSlashEntries,
	namespacedSkillToken,
	resolveSlashInput,
} from "./slash-registry.js";

describe("slash registry", () => {
	test("includes built-in /skills command", () => {
		const builtIns = getBuiltInSlashCommands();
		expect(builtIns.some((cmd) => cmd.name === "skills")).toBeTrue();
	});

	const builtInVoice: SlashRegistryEntry = {
		token: "/voice",
		name: "voice",
		canonicalName: "voice",
		description: "built in",
		kind: "builtin",
		builtInName: "voice",
	};
	const skillVoice: SlashRegistryEntry = {
		token: "/voice",
		name: "voice",
		canonicalName: "voice-chat-mode",
		description: "skill",
		kind: "skill",
		skillName: "voice-chat-mode",
	};

	test("a skill trigger that matches a builtin resolves to the builtin (#2932)", () => {
		const merged = mergeSlashEntries([builtInVoice], [skillVoice]);
		expect(merged.byToken.get("/voice")?.kind).toBe("builtin");
		expect(merged.byToken.get("/voice")?.builtInName).toBe("voice");
		const resolved = resolveSlashInput("/voice on", merged);
		expect(resolved?.entry.kind).toBe("builtin");
		expect(resolved?.args).toEqual(["on"]);
	});

	test("the colliding skill stays reachable as /skill:<name>", () => {
		const merged = mergeSlashEntries([builtInVoice], [skillVoice]);
		expect(namespacedSkillToken("/voice")).toBe("/skill:voice");
		const entry = merged.byToken.get("/skill:voice");
		expect(entry?.kind).toBe("skill");
		expect(entry?.skillName).toBe("voice-chat-mode");
		expect(entry?.name).toBe("skill:voice");
		const resolved = resolveSlashInput("/skill:voice test", merged);
		expect(resolved?.entry.kind).toBe("skill");
		expect(resolved?.args).toEqual(["test"]);
		// Both forms are listed for completion; the raw token is listed once.
		expect(merged.entries.filter((e) => e.token === "/voice")).toHaveLength(1);
		expect(merged.entries.some((e) => e.token === "/skill:voice")).toBeTrue();
	});

	test("the registry records the collision once and formats one startup line", () => {
		// A skill's canonical name and its alias key normalize to the same
		// token, so the skill side can present the same collision twice.
		const merged = mergeSlashEntries([builtInVoice], [skillVoice, { ...skillVoice }]);
		expect(merged.collisions).toEqual([
			{
				token: "/voice",
				builtInName: "voice",
				skillName: "voice-chat-mode",
				namespacedToken: "/skill:voice",
			},
		]);
		expect(formatSlashCollisionLine(merged.collisions)).toBe(
			"Slash command collision: /voice is the builtin; skill voice-chat-mode is /skill:voice.",
		);
	});

	test("no collision behaves as before: skill token resolves to the skill, nothing recorded", () => {
		const skillOnly: SlashRegistryEntry = { ...skillVoice, token: "/vcm", name: "vcm" };
		const merged = mergeSlashEntries([builtInVoice], [skillOnly]);
		expect(merged.byToken.get("/vcm")?.kind).toBe("skill");
		expect(merged.byToken.get("/voice")?.kind).toBe("builtin");
		expect(merged.byToken.has("/skill:vcm")).toBeFalse();
		expect(merged.collisions).toEqual([]);
		expect(formatSlashCollisionLine(merged.collisions)).toBeNull();
	});

	test("bundled boardroom alias /board loses to the builtin kanban alias and lives at /skill:board", async () => {
		// packages/skills/boardroom/SKILL.md declares aliases [/board, /convene];
		// the builtin kanban command owns /board. Deterministic in any checkout.
		const registry = await getSlashRegistry();
		expect(registry.byToken.get("/board")?.kind).toBe("builtin");
		expect(registry.byToken.get("/board")?.builtInName).toBe("kanban");
		expect(registry.byToken.get("/skill:board")?.kind).toBe("skill");
		expect(registry.byToken.get("/skill:board")?.skillName).toBe("boardroom");
		expect(registry.byToken.get("/boardroom")?.kind).toBe("skill");
		expect(
			registry.collisions.some((c) => c.token === "/board" && c.builtInName === "kanban"),
		).toBeTrue();
		// Every builtin token, aliases included, is a builtin in the merged registry.
		for (const cmd of getBuiltInSlashCommands()) {
			for (const name of [cmd.name, ...cmd.aliases]) {
				expect(registry.byToken.get(`/${name.toLowerCase()}`)?.kind).toBe("builtin");
			}
		}
	});

	test("loads skill aliases and resolves slash input", async () => {
		const registry = await getSlashRegistry();
		const exact = registry.byToken.get("/billiondollarboardroom");
		const alias = registry.byToken.get("/bdb");
		expect(exact?.kind).toBe("skill");
		expect(alias?.kind).toBe("skill");

		const resolved = resolveSlashInput("/bdb pricing audit", registry);
		expect(resolved?.entry.kind).toBe("skill");
		expect(resolved?.args).toEqual(["pricing", "audit"]);
	});

	test("unknown slash token does not resolve", async () => {
		const registry = await getSlashRegistry();
		const resolved = resolveSlashInput("/definitely-not-real", registry);
		expect(resolved).toBeNull();
	});

	test("skill summary is canonicalized by name", async () => {
		const registry = await getSlashRegistry();
		const summary = getSkillSummary(registry);
		const boardroom = summary.find((s) => s.name === "billiondollarboardroom");
		expect(boardroom).toBeDefined();
	});
});
