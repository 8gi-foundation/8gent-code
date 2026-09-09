import { describe, expect, test } from "bun:test";
import {
	HELP_MAP,
	type HelpEntry,
	renderHelp,
	renderHelpAll,
	renderHelpCommand,
	renderHelpMap,
} from "./help-map.js";
import { getBuiltInSlashCommands } from "./slash-registry.js";

/** Build help entries the same way the registry does, from the real builtin table. */
function builtinEntries(): HelpEntry[] {
	const out: HelpEntry[] = [];
	for (const c of getBuiltInSlashCommands()) {
		out.push({
			token: `/${c.name}`,
			name: c.name,
			canonicalName: c.name,
			description: c.description,
			usage: c.usage,
			kind: "builtin",
		});
		for (const alias of c.aliases) {
			out.push({
				token: `/${alias}`,
				name: alias,
				canonicalName: c.name,
				description: c.description,
				usage: c.usage,
				kind: "builtin",
			});
		}
	}
	return out;
}

function skill(name: string, description: string): HelpEntry {
	return { token: `/${name}`, name, canonicalName: name, description, kind: "skill" };
}

/** Every /word token printed on the map, without trailing punctuation. */
function commandsMentioned(lines: string[]): string[] {
	const out: string[] = [];
	for (const line of lines) {
		for (const m of line.matchAll(/\/([a-z][a-z0-9-]*)/g)) out.push(m[1]);
	}
	return out;
}

describe("renderHelpMap", () => {
	test("every command on the map exists in the input registry", () => {
		const entries = builtinEntries();
		const names = new Set(entries.map((e) => e.name));
		const lines = renderHelpMap(entries, 100);
		const mentioned = commandsMentioned(lines).filter((n) => n !== "help" && n !== "name");
		expect(mentioned.length).toBeGreaterThan(8);
		for (const n of mentioned) expect(names.has(n)).toBeTrue();
	});

	test("fits on one screen at 100 columns", () => {
		const lines = renderHelpMap(builtinEntries(), 100);
		expect(lines.length).toBeLessThanOrEqual(20);
		for (const line of lines) expect(line.length).toBeLessThanOrEqual(100);
	});

	test("a missing command drops its line and keeps the rest of the section", () => {
		const all = builtinEntries();
		const withoutEvidence = all.filter((e) => e.canonicalName !== "evidence");
		const before = renderHelpMap(all, 100).join("\n");
		const after = renderHelpMap(withoutEvidence, 100).join("\n");
		expect(before).toContain("/evidence");
		expect(after).not.toContain("/evidence");
		expect(after).toContain("/build <task>");
		expect(after).toContain("Work");
	});

	test("an item depending on two commands drops when either is missing", () => {
		const withoutProvider = builtinEntries().filter((e) => e.canonicalName !== "provider");
		const text = renderHelpMap(withoutProvider, 100).join("\n");
		expect(text).not.toContain("/model and /provider");
		expect(text).toContain("/settings");
	});

	test("a section with no registered commands drops its heading", () => {
		const entries = builtinEntries();
		// The builtin table registers no /notes, /ideas, /btw or /questions.
		expect(entries.some((e) => e.name === "notes")).toBeFalse();
		const text = renderHelpMap(entries, 100).join("\n");
		expect(text).not.toContain("Notes and ideas");
		expect(text).not.toContain("/notes");
	});

	test("a section appears once its commands are registered", () => {
		const entries = [
			...builtinEntries(),
			skill("notes", "Open notes"),
			skill("ideas", "Open ideas"),
		];
		const text = renderHelpMap(entries, 100).join("\n");
		expect(text).toContain("Notes and ideas");
		expect(text).toContain("/notes (Ctrl+N)");
		expect(text).toContain("/ideas");
		expect(text).not.toContain("/btw");
	});

	test("the map ends with the line pointing at /help all and /help <name>", () => {
		const lines = renderHelpMap(builtinEntries(), 100);
		expect(lines[lines.length - 1]).toContain("/help all");
		expect(lines[lines.length - 1]).toContain("/help <name>");
	});

	test("an empty registry prints only the last line", () => {
		const lines = renderHelpMap([], 80);
		expect(lines).toHaveLength(1);
		expect(lines[0]).toContain("/help all");
	});

	test("narrow width breaks between items, never mid-item, and never exceeds width", () => {
		const lines = renderHelpMap(builtinEntries(), 30);
		for (const line of lines) expect(line.length).toBeLessThanOrEqual(30);
		expect(lines.join("\n")).toContain("/build <task>");
		expect(lines.length).toBeGreaterThan(renderHelpMap(builtinEntries(), 100).length);
	});

	test("width below the floor is clamped and single items are truncated with an ellipsis", () => {
		const lines = renderHelpMap(builtinEntries(), 5);
		for (const line of lines) expect(line.length).toBeLessThanOrEqual(16);
		expect(lines.some((l) => l.endsWith("…"))).toBeTrue();
	});

	test("every command named in HELP_MAP is a real builtin or one of the four tab commands", () => {
		const builtin = new Set<string>(getBuiltInSlashCommands().map((c) => c.name));
		const tabs = new Set(["notes", "ideas", "btw", "questions"]);
		for (const section of HELP_MAP) {
			for (const item of section.items) {
				for (const c of item.commands) expect(builtin.has(c) || tabs.has(c)).toBeTrue();
			}
		}
	});
});

describe("renderHelpAll", () => {
	test("lists every canonical command once, one per line, no aliases as rows", () => {
		const entries = builtinEntries();
		const lines = renderHelpAll(entries, 120);
		const canonical = getBuiltInSlashCommands().map((c) => c.name);
		const rows = lines.filter((l) => l.startsWith("  /"));
		expect(rows).toHaveLength(canonical.length);
		for (const name of canonical) expect(rows.some((r) => r.startsWith(`  /${name} `))).toBeTrue();
		expect(rows.some((r) => r.startsWith("  /cls "))).toBeFalse();
	});

	test("never exceeds the column width", () => {
		for (const width of [24, 40, 60, 80]) {
			const lines = renderHelpAll(builtinEntries(), width);
			for (const line of lines) expect(line.length).toBeLessThanOrEqual(width);
		}
	});

	test("narrow column shrinks the name column so descriptions stay visible", () => {
		const lines = renderHelpAll(builtinEntries(), 25);
		const status = lines.find((l) => l.startsWith("  /status"));
		expect(status).toBeDefined();
		expect(status).toContain("Show ses");
		expect(lines[0]).toBe(`${getBuiltInSlashCommands().length} commands`);
	});

	test("truncates long descriptions with an ellipsis instead of wrapping", () => {
		const lines = renderHelpAll(builtinEntries(), 40);
		const term = lines.find((l) => l.startsWith("  /term "));
		expect(term).toBeDefined();
		expect(term?.endsWith("…")).toBeTrue();
		expect(term?.length).toBe(40);
	});

	test("skills come after builtins under their own heading", () => {
		const entries = [...builtinEntries(), skill("bdb", "Boardroom")];
		const lines = renderHelpAll(entries, 100);
		const builtinIdx = lines.indexOf("Built in");
		const skillIdx = lines.indexOf("Skills");
		expect(builtinIdx).toBeGreaterThan(0);
		expect(skillIdx).toBeGreaterThan(builtinIdx);
		expect(lines[skillIdx + 1]).toStartWith("  /bdb ");
	});

	test("empty registry says so", () => {
		expect(renderHelpAll([], 80)).toEqual(["No commands are registered."]);
	});
});

describe("renderHelpCommand", () => {
	test("prints name, description, usage and aliases", () => {
		const lines = renderHelpCommand(builtinEntries(), "status", 100);
		expect(lines[0]).toBe("/status");
		expect(lines[1]).toBe("  Show session status");
		expect(lines.join("\n")).toContain("Also: /s, /st");
		const model = renderHelpCommand(builtinEntries(), "model", 100);
		expect(model.join("\n")).toContain("Usage: /model [name]");
	});

	test("accepts a leading slash and resolves an alias to its command", () => {
		const viaAlias = renderHelpCommand(builtinEntries(), "/st", 100);
		expect(viaAlias.slice(0, 2)).toEqual(["/status", "  Show session status"]);
	});

	test("unknown name points at /help all", () => {
		const lines = renderHelpCommand(builtinEntries(), "nope", 100);
		expect(lines).toHaveLength(1);
		expect(lines[0]).toContain("No command named /nope");
		expect(lines[0]).toContain("/help all");
	});

	test("skill entries say they expand to a prompt", () => {
		const entries = [...builtinEntries(), skill("bdb", "Boardroom")];
		const lines = renderHelpCommand(entries, "bdb", 100);
		expect(lines.slice(0, 2)).toEqual(["/bdb", "  Boardroom"]);
		expect(lines.join("\n")).toContain("Skill");
	});

	test("a long description wraps to the width instead of truncating", () => {
		const lines = renderHelpCommand(builtinEntries(), "term", 30);
		for (const line of lines) expect(line.length).toBeLessThanOrEqual(30);
		const text = lines.join(" ").replace(/\s+/g, " ");
		expect(text).toContain("anything else is run via the shell");
		expect(lines.some((l) => l.endsWith("\u2026"))).toBeFalse();
	});
});

describe("renderHelp", () => {
	test("no args gives the map, all gives the list, a name gives one command", () => {
		const entries = builtinEntries();
		expect(renderHelp(entries, [], 100)).toEqual(renderHelpMap(entries, 100));
		expect(renderHelp(entries, ["all"], 100)).toEqual(renderHelpAll(entries, 100));
		expect(renderHelp(entries, ["ALL"], 100)).toEqual(renderHelpAll(entries, 100));
		expect(renderHelp(entries, ["quit"], 100)).toEqual(renderHelpCommand(entries, "quit", 100));
	});
});

describe("short forms", () => {
	test("a long item falls back to its short form in a narrow column", () => {
		const wide = renderHelpMap(builtinEntries(), 100).join("\n");
		const narrow = renderHelpMap(builtinEntries(), 25).join("\n");
		expect(wide).toContain("/model and /provider choose what answers");
		expect(narrow).toContain("/model and /provider");
		expect(narrow).not.toContain("/model and /provider choose");
		expect(narrow).toContain("ask in plain words");
		expect(narrow).toContain("Shift+Tab cycles tabs");
	});
});
