import { describe, expect, test } from "bun:test";
import { SLASH_MENU_ROWS, slashMenuRows } from "../components/command-input.js";
import {
	BUILT_IN_SLASH_COMMANDS,
	CORE_SLASH_COMMANDS,
	builtInCommandsCoreFirst,
	formatSlashHelp,
} from "./slash-commands.js";
import type { SlashRegistryEntry } from "./slash-registry.js";

// Built-ins only, canonical names plus aliases, the way the registry builds
// them. Loaded skills are left out so the test does not depend on the machine.
const ENTRIES: SlashRegistryEntry[] = BUILT_IN_SLASH_COMMANDS.flatMap((c) =>
	[c.name, ...c.aliases].map((name) => ({
		token: `/${name}`,
		name,
		canonicalName: c.name,
		description: c.description,
		kind: "builtin" as const,
		builtInName: c.name,
	})),
);

describe("core command menu (#3918 D9)", () => {
	test("a bare / fits in the menu: 14 rows or fewer, settings and resume in it", () => {
		expect(CORE_SLASH_COMMANDS.size).toBeLessThanOrEqual(SLASH_MENU_ROWS);
		expect(slashMenuRows("", ENTRIES).length).toBeLessThanOrEqual(SLASH_MENU_ROWS);
		expect(CORE_SLASH_COMMANDS.has("settings")).toBeTrue();
		expect(CORE_SLASH_COMMANDS.has("resume")).toBeTrue();
	});

	test("every core command is a real built-in", () => {
		const names = new Set(BUILT_IN_SLASH_COMMANDS.map((c) => c.name));
		for (const name of CORE_SLASH_COMMANDS) expect(names.has(name)).toBeTrue();
	});

	test("a bare / lists core commands only, no aliases, no novelty", () => {
		const rows = slashMenuRows("", ENTRIES);
		const names = rows.map((r) => r.name);
		expect(names.toSorted()).toEqual([...CORE_SLASH_COMMANDS].toSorted());
		for (const novelty of ["dj", "pet", "music", "kanban", "vercel", "telegram", "design"]) {
			expect(names).not.toContain(novelty);
		}
		expect(rows.every((r) => r.kind === "builtin")).toBeTrue();
	});

	test("typing a prefix still reaches hidden commands, core first", () => {
		expect(slashMenuRows("dj", ENTRIES).map((r) => r.name)).toContain("dj");
		const p = slashMenuRows("p", ENTRIES).map((r) => r.name);
		expect(p).toContain("pet");
		expect(p.indexOf("plan")).toBeLessThan(p.indexOf("pet"));
		expect(p.indexOf("provider")).toBeLessThan(p.indexOf("pet"));
	});

	test("palette order puts core commands first and keeps every command", () => {
		const ordered = builtInCommandsCoreFirst();
		expect(ordered.length).toBe(BUILT_IN_SLASH_COMMANDS.length);
		const firstNonCore = ordered.findIndex((c) => !CORE_SLASH_COMMANDS.has(c.name));
		expect(firstNonCore).toBe(CORE_SLASH_COMMANDS.size);
	});

	test("/help shows core commands; /help all shows every built-in", () => {
		const core = formatSlashHelp(false);
		expect(core).toContain("/model");
		expect(core).not.toContain("/dj");
		expect(core).toContain("/help all");
		const all = formatSlashHelp(true);
		for (const c of BUILT_IN_SLASH_COMMANDS) expect(all).toContain(c.usage ?? `/${c.name}`);
	});
});
