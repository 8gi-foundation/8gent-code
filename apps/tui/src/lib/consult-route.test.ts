import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
	type SlashRegistryEntry,
	getBuiltInSlashCommands,
	mergeSlashEntries,
	resolveSlashInput,
} from "./slash-registry.js";

const here = import.meta.dir;
const read = (rel: string) => readFileSync(join(here, rel), "utf8");

describe("/consult line is not stored raw (#4608)", () => {
	test("it resolves to a built-in with the question as args", () => {
		const entries: SlashRegistryEntry[] = getBuiltInSlashCommands().map((c) => ({
			token: `/${c.name}`,
			name: c.name,
			canonicalName: c.name,
			description: c.description,
			kind: "builtin" as const,
			builtInName: c.name as any,
		}));
		const r = resolveSlashInput(
			"/consult why does key sk-abc fail for me@x.com",
			mergeSlashEntries(entries, [], []),
		);
		expect(r?.entry.kind).toBe("builtin");
		expect(r?.entry.builtInName).toBe("consult");
		expect(r?.args.join(" ")).toContain("why does key");
	});

	test("the input box hands a built-in slash line to onSlashCommand and returns before onSubmit", () => {
		const src = read("../components/command-input.tsx");
		const slash = src.indexOf("onSlashCommand(resolved.entry.builtInName, resolved.args);");
		const submit = src.indexOf("onSubmit(input);", slash);
		expect(slash).toBeGreaterThan(0);
		expect(submit).toBeGreaterThan(slash);
		const between = src.slice(slash, submit);
		expect(between).toContain("return;");
	});

	test("the consult handler never writes the raw line to history, the transcript or the session log", () => {
		const src = read("../app.tsx");
		const start = src.indexOf('command === ("consult" as any)');
		const end = src.indexOf('command === ("route" as any)', start);
		expect(start).toBeGreaterThan(0);
		const block = src.slice(start, end);
		for (const bad of [
			"setRecentCommands",
			"appendToTab",
			"logMessage",
			"autoKanban",
			"bubbleContent",
		]) {
			expect(block).not.toContain(bad);
		}
	});
});
