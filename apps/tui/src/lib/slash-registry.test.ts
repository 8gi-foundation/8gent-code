import { describe, expect, test } from "bun:test";
import {
	type SlashRegistryEntry,
	getBuiltInSlashCommands,
	getSkillSummary,
	getSlashRegistry,
	mergeSlashEntries,
	resolveSlashInput,
} from "./slash-registry.js";

describe("slash registry", () => {
	test("includes built-in /skills command", () => {
		const builtIns = getBuiltInSlashCommands();
		expect(builtIns.some((cmd) => cmd.name === "skills")).toBeTrue();
	});

	test("mergeSlashEntries prefers skill entry on token collision", () => {
		const builtInEntry: SlashRegistryEntry = {
			token: "/example",
			name: "example",
			canonicalName: "example",
			description: "built in",
			kind: "builtin",
			builtInName: "help",
		};
		const skillEntry: SlashRegistryEntry = {
			token: "/example",
			name: "example",
			canonicalName: "example-skill",
			description: "skill",
			kind: "skill",
			skillName: "example-skill",
		};
		const merged = mergeSlashEntries([builtInEntry], [skillEntry]);
		expect(merged.byToken.get("/example")?.kind).toBe("skill");
		expect(merged.byToken.get("/example")?.canonicalName).toBe("example-skill");
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
