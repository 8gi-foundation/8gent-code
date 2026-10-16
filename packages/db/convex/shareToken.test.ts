import { describe, expect, test } from "bun:test";
import { makeToken } from "./shareToken";

describe("makeToken", () => {
	test("default length is at least 24", () => {
		expect(makeToken().length).toBeGreaterThanOrEqual(24);
	});
	test("only url-safe lowercase alphabet characters", () => {
		for (let i = 0; i < 200; i++) expect(makeToken()).toMatch(/^[a-km-z2-9]+$/);
	});
	test("1000 draws are unique", () => {
		const seen = new Set<string>();
		for (let i = 0; i < 1000; i++) seen.add(makeToken());
		expect(seen.size).toBe(1000);
	});
	test("uses crypto, not Math.random", () => {
		const orig = Math.random;
		Math.random = () => {
			throw new Error("Math.random used");
		};
		try {
			makeToken();
		} finally {
			Math.random = orig;
		}
	});
});
