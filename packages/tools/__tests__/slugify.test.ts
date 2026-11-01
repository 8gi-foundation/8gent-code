/**
 * Tests for packages/tools/slugify.ts - the shared slug helper used by
 * packages/memory/wiki.ts (wiki filenames and links) and
 * packages/app-creator/creator.ts (app manifest names).
 *
 * The wiki parity suite is the critical one: wiki slugs become filenames
 * and markdown links on disk, so for ASCII input the shared slugify must
 * stay byte-identical to the legacy wiki implementation forever. The
 * fixtures in fixtures/wiki-slug-parity.json were generated FROM the
 * legacy implementation before it was replaced. Do not regenerate them
 * from the new implementation - that would defeat the parity guarantee.
 */

import { describe, expect, test } from "bun:test";
import { slugify } from "../slugify";
import parityFixtures from "./fixtures/wiki-slug-parity.json";

describe("slugify", () => {
	test("lowercases output", () => {
		expect(slugify("HELLO")).toBe("hello");
		expect(slugify("CamelCaseName")).toBe("camelcasename");
		expect(slugify("UPPER_CASE_NAME")).toBe("upper-case-name");
	});

	test("trims and converts whitespace to the separator", () => {
		expect(slugify("  hello world  ")).toBe("hello-world");
		expect(slugify("tabs\tand\nnewlines")).toBe("tabs-and-newlines");
	});

	test("collapses consecutive separators", () => {
		expect(slugify("multiple---hyphens")).toBe("multiple-hyphens");
		expect(slugify("a _ - _ b")).toBe("a-b");
	});

	test("strips leading and trailing separators", () => {
		expect(slugify("--flags--")).toBe("flags");
		expect(slugify("...dots...")).toBe("dots");
		expect(slugify("!!!")).toBe("");
	});

	test("replaces runs of non-alphanumerics with a single separator", () => {
		expect(slugify("foo@bar#baz")).toBe("foo-bar-baz");
		expect(slugify("node.js")).toBe("node-js");
		expect(slugify("async/await")).toBe("async-await");
		expect(slugify("Memory v2 (SQLite)")).toBe("memory-v2-sqlite");
	});

	test("accepts a custom separator", () => {
		expect(slugify("Hello World", "_")).toBe("hello_world");
		expect(slugify("foo@bar#baz", "_")).toBe("foo_bar_baz");
		expect(slugify("__x__", "_")).toBe("x");
		expect(slugify("a - b", ".")).toBe("a.b");
	});

	test("strips diacritics via NFKD decomposition (no transliteration tables)", () => {
		expect(slugify("Crème Brûlée")).toBe("creme-brulee");
		expect(slugify("café")).toBe("cafe");
		expect(slugify("über")).toBe("uber");
		expect(slugify("naïve résumé")).toBe("naive-resume");
		expect(slugify("Señor")).toBe("senor");
		// NFKD compatibility decomposition also unfolds ligatures.
		expect(slugify("ﬁle")).toBe("file");
	});

	test("drops non-decomposable non-ASCII instead of transliterating", () => {
		// No transliteration tables: characters with no base-letter
		// decomposition are treated as separators, not mapped to ASCII.
		expect(slugify("日本語")).toBe("");
		expect(slugify("smart†quote")).toBe("smart-quote");
	});

	test("handles empty and symbol-only input", () => {
		expect(slugify("")).toBe("");
		expect(slugify("   ")).toBe("");
		expect(slugify("---")).toBe("");
	});

	test("preserves digits", () => {
		expect(slugify("GPT-4o")).toBe("gpt-4o");
		expect(slugify("v1.2.3-beta.1")).toBe("v1-2-3-beta-1");
		expect(slugify("007")).toBe("007");
	});
});

describe("slugify wiki parity (byte-identical to legacy wiki slugify)", () => {
	// Legacy implementation copied verbatim from packages/memory/wiki.ts
	// before the migration. Kept here as a second, independent parity
	// oracle alongside the frozen JSON fixtures.
	function legacyWikiSlugify(name: string): string {
		return name
			.toLowerCase()
			.replace(/[^a-z0-9]+/g, "-")
			.replace(/^-+|-+$/g, "")
			.replace(/-{2,}/g, "-");
	}

	test("matches all frozen fixtures generated from the old implementation", () => {
		expect(parityFixtures.length).toBeGreaterThanOrEqual(350);
		for (const { input, expected } of parityFixtures as Array<{
			input: string;
			expected: string;
		}>) {
			expect(slugify(input)).toBe(expected);
		}
	});

	test("matches the legacy implementation across a deterministic ASCII corpus", () => {
		// mulberry32 PRNG with a fixed seed: same corpus on every run.
		let a = 0x1234abcd;
		const rand = () => {
			a |= 0;
			a = (a + 0x6d2b79f5) | 0;
			let t = Math.imul(a ^ (a >>> 15), 1 | a);
			t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
			return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
		};
		const printable = Array.from({ length: 95 }, (_, i) => String.fromCharCode(0x20 + i)).join(
			"",
		);
		for (let i = 0; i < 500; i++) {
			const len = Math.floor(rand() * 48);
			let s = "";
			for (let j = 0; j < len; j++) {
				s += printable[Math.floor(rand() * printable.length)];
			}
			expect(slugify(s)).toBe(legacyWikiSlugify(s));
		}
	});
});
