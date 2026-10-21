import { describe, expect, test } from "bun:test";
import {
	type SlashRegistryEntry,
	formatSlashCollisionLine,
	isBareSlash,
	slashCollisionNotice,
	getBuiltInSlashCommands,
	getSkillSummary,
	getSlashRegistry,
	mergeSlashEntries,
	namespacedSkillToken,
	resolveSlashInput,
	unknownSlashAnswer,
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

	test("the collision line stays off the first screen unless DEBUG=1 (#4703)", () => {
		const merged = mergeSlashEntries([builtInVoice], [skillVoice]);
		expect(slashCollisionNotice(merged.collisions, {})).toBeNull();
		expect(slashCollisionNotice(merged.collisions, { DEBUG: "0" })).toBeNull();
		expect(slashCollisionNotice(merged.collisions, { DEBUG: "1" })).toBe(
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

	// The workspace tab commands are handled in app.tsx but were never in
	// BUILT_IN_SLASH_COMMANDS, so typed /notes fell through to chat (#2939).
	const TAB_COMMANDS = ["notes", "ideas", "btw", "questions", "projects", "terminal"] as const;

	test("workspace tab commands are registered as builtins", () => {
		const builtIns = getBuiltInSlashCommands();
		for (const name of TAB_COMMANDS) {
			const def = builtIns.find((cmd) => cmd.name === name);
			expect(def).toBeDefined();
			expect(def?.description.length).toBeGreaterThan(0);
			expect(def?.usage?.startsWith(`/${name}`)).toBeTrue();
		}
	});

	test("workspace tab commands resolve as builtins from typed input", async () => {
		const registry = await getSlashRegistry();
		for (const name of TAB_COMMANDS) {
			const resolved = resolveSlashInput(`/${name}`, registry);
			expect(resolved?.entry.kind).toBe("builtin");
			expect(resolved?.entry.builtInName).toBe(name);
			expect(resolved?.args).toEqual([]);
		}
	});

	test("/terminal passes its label through as an argument", async () => {
		const registry = await getSlashRegistry();
		const resolved = resolveSlashInput("/terminal build-watch", registry);
		expect(resolved?.entry.builtInName).toBe("terminal");
		expect(resolved?.args).toEqual(["build-watch"]);
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

describe("unknownSlashAnswer (#4530)", () => {
	const loaded = mergeSlashEntries(
		[],
		[
			{
				token: "/hyperframes",
				name: "hyperframes",
				canonicalName: "hyperframes",
				description: "skill",
				kind: "skill",
				skillName: "hyperframes",
			},
		],
	);

	const none = { skillExists: async () => false, templateMatches: () => false };
	const empty = { entries: [], byToken: new Map(), collisions: [] };

	test("an unknown slash line gets the local answer, leading whitespace included", async () => {
		expect(await unknownSlashAnswer("/nope", loaded, none)).toBe(
			"Unknown command /nope. Type /help.",
		);
		expect(await unknownSlashAnswer("  /nope with args", loaded, none)).toBe(
			"Unknown command /nope. Type /help.",
		);
	});

	test("a bare slash is never an error: it is the help request (#4703)", async () => {
		for (const bare of ["/", "  /", "/  ", " / \t"]) {
			expect(isBareSlash(bare)).toBeTrue();
			expect(await unknownSlashAnswer(bare, loaded, none)).toBeNull();
		}
		expect(isBareSlash("/help")).toBeFalse();
		expect(isBareSlash("//")).toBeFalse();
		expect(isBareSlash("/ x")).toBeFalse();
	});

	test("a path-like line gets the local answer", async () => {
		expect(await unknownSlashAnswer("/Users/x/file explain this", loaded, none)).toBe(
			"Unknown command /Users/x/file. Type /help.",
		);
	});

	test("a built-in, an alias and a skill trigger are known", async () => {
		for (const cmd of getBuiltInSlashCommands()) {
			expect(await unknownSlashAnswer(`/${cmd.name}`, loaded, none)).toBeNull();
			for (const a of cmd.aliases)
				expect(await unknownSlashAnswer(a.startsWith("/") ? a : `/${a}`, loaded, none)).toBeNull();
		}
		expect(await unknownSlashAnswer("/hyperframes make a reel", loaded, none)).toBeNull();
	});

	test("a built-in is known even before the registry has loaded", async () => {
		expect(await unknownSlashAnswer("/help", empty, none)).toBeNull();
	});

	test("a skill typed before the registry loads, or added at runtime, is known", async () => {
		const skills = { ...none, skillExists: async (n: string) => n === "late-skill" };
		expect(await unknownSlashAnswer("/late-skill go", empty, skills)).toBeNull();
		expect(await unknownSlashAnswer("/other go", empty, skills)).not.toBeNull();
	});

	test("a template saved after the registry was built is known", async () => {
		const tpl = { ...none, templateMatches: (l: string) => l.startsWith("/newtemplate") };
		expect(await unknownSlashAnswer("/newtemplate x", loaded, tpl)).toBeNull();
	});

	test("/skill:<name> is left to the skill handler", async () => {
		expect(await unknownSlashAnswer("/skill:nope", empty, none)).toBeNull();
	});

	test("plain text is not a slash line", async () => {
		expect(await unknownSlashAnswer("hello /nope", loaded, none)).toBeNull();
		expect(await unknownSlashAnswer("what is 1/2", loaded, none)).toBeNull();
	});

	test("the default lookups read templates and skills fresh", async () => {
		expect(await unknownSlashAnswer("/zz-no-such-thing-4536 a", empty)).toBe(
			"Unknown command /zz-no-such-thing-4536. Type /help.",
		);
	});
});
