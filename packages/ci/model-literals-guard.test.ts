/**
 * Guard: no new hardcoded model names in product code.
 * For every 8gent user, so the model they run is one their provider offers
 * today. Definition and scan live in scripts/model-literals.ts; the debt that
 * already existed is frozen in scripts/model-literals.allow.json (file ->
 * literal -> allowed occurrences, no line numbers). The list may only shrink.
 */
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { type Hit, findLiteralsInText, isProductFile, scan } from "../../scripts/model-literals";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
type Allow = Record<string, Record<string, number>>;

function violations(hits: Hit[], allow: Allow): string[] {
	const seen = new Map<string, number>();
	const out: string[] = [];
	for (const h of hits) {
		const key = `${h.file}\0${h.literal}`;
		const n = (seen.get(key) ?? 0) + 1;
		seen.set(key, n);
		if (n > (allow[h.file]?.[h.literal] ?? 0)) {
			out.push(
				`New hardcoded model literal "${h.literal}" at ${h.file}:${h.line}. Discover the model from the provider's live list instead. (Do not add it to scripts/model-literals.allow.json.)`,
			);
		}
	}
	return out;
}

const allow: Allow = JSON.parse(
	readFileSync(join(ROOT, "scripts/model-literals.allow.json"), "utf8"),
).entries;

describe("model literal guard", () => {
	test("no model literal outside the allow-list", () => {
		const v = violations(scan(ROOT), allow);
		expect(v.join("\n")).toBe("");
	});

	test("a new literal fails with the discover-live message", () => {
		const hits = findLiteralsInText("packages/x.ts", `const m = "qwen9:1b";`);
		const v = violations(hits, allow);
		expect(v).toHaveLength(1);
		expect(v[0]).toContain("qwen9:1b");
		expect(v[0]).toContain("Discover the model from the provider's live list instead");
	});

	test("an extra occurrence of an allowed literal still fails", () => {
		const hits: Hit[] = [
			{ file: "a.ts", line: 1, literal: "qwen3:14b" },
			{ file: "a.ts", line: 2, literal: "qwen3:14b" },
		];
		expect(violations(hits, { "a.ts": { "qwen3:14b": 1 } })).toHaveLength(1);
		expect(violations(hits, { "a.ts": { "qwen3:14b": 2 } })).toHaveLength(0);
	});

	test("definition: excludes tests, fixtures, markdown, runtime names, paths", () => {
		expect(isProductFile("packages/a/x.ts")).toBe(true);
		expect(isProductFile("packages/a/x.test.ts")).toBe(false);
		expect(isProductFile("packages/a/__tests__/x.ts")).toBe(false);
		expect(isProductFile("packages/a/fixtures/x.ts")).toBe(false);
		expect(isProductFile("docs/x.md")).toBe(false);
		const t = (s: string) => findLiteralsInText("f.ts", s).length;
		expect(t(`x("llama-server")`)).toBe(0);
		expect(t(`x("claude-code")`)).toBe(0);
		expect(t(`x("./llama-router")`)).toBe(0);
		expect(t(`x("a claude-3 sentence")`)).toBe(0);
		expect(t(`x("openrouter/auto:free")`)).toBe(1);
		expect(t(`x("MiniMax-M2.7")`)).toBe(1);
		expect(t(`x("eight-1.0-q3:14b")`)).toBe(1);
	});
});
