import { describe, expect, test } from "bun:test";
import { slashMenuRows } from "../components/command-input.js";
import { formatSlashHelp } from "./slash-commands.js";
import { editDistance, nearestNames, unknownSlashAnswer } from "./slash-registry.js";

const none = { skillExists: async () => false, templateMatches: () => false };
const empty = { entries: [], byToken: new Map(), collisions: [] };

describe("nearestNames", () => {
	test("edit distance", () => {
		expect(editDistance("kitten", "sitting")).toBe(3);
		expect(editDistance("", "ab")).toBe(2);
	});
	test("prefix, then substring, then typo", () => {
		const names = ["model", "mode", "login", "compact", "clear"];
		expect(nearestNames("mod", names)).toEqual(["model", "mode"]);
		expect(nearestNames("ogin", names)).toEqual(["login"]);
		expect(nearestNames("compcat", names)).toEqual(["compact"]);
		expect(nearestNames("zzzzzz", names)).toEqual([]);
	});
});

describe("unknown command suggests", () => {
	test("a typo gets Did you mean", async () => {
		const out = await unknownSlashAnswer("/modle", empty, none);
		expect(out).toContain("Did you mean");
		expect(out).toContain("/model");
		expect(out).toContain("Type /help.");
	});
	test("no near match keeps the plain answer", async () => {
		expect(await unknownSlashAnswer("/zzqqxxvv", empty, none)).toBe(
			"Unknown command /zzqqxxvv. Type /help.",
		);
	});
});

describe("menu falls back to nearest", () => {
	test("a typo shows near commands, not an empty menu", async () => {
		const { getBuiltInSlashRegistry } = await import("./slash-registry.js");
		const entries = getBuiltInSlashRegistry().entries;
		expect(slashMenuRows("modle", entries).map((e) => e.name)).toContain("model");
	});
});

describe("/help on a phone", () => {
	test("45 columns: short, no desktop tips, no line over 45", () => {
		const text = formatSlashHelp(false, { columns: 45, android: true });
		expect(text).not.toMatch(/iTerm2|Terminal\.app|triple click|DJ/);
		expect(text).toContain("/help all");
		expect(text).toContain("Touch:");
		expect(text.split("\n").length).toBeLessThanOrEqual(6);
	});
	test("45 columns /help all drops /debug in installed builds", () => {
		const text = formatSlashHelp(true, { columns: 45, hasDebug: false });
		expect(text).not.toContain("/debug");
		expect(text).toContain("/model");
	});
	test("wide desktop keeps mouse tips", () => {
		expect(formatSlashHelp(false, { columns: 120 })).toContain("iTerm2");
	});
});
