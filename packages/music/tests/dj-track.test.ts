import { describe, expect, test } from "bun:test";
import { DJ, keyLabel } from "../dj";

describe("DJ track info and key wording (#3192)", () => {
	test("key labels say where the key came from, and never guess", () => {
		expect(keyLabel({ state: "tag", key: "A minor" })).toBe("Key: A minor");
		expect(keyLabel({ state: "estimated", key: "F minor" })).toBe("Key: F minor (est.)");
		expect(keyLabel({ state: "detecting", key: null })).toBe("Key: detecting...");
		expect(keyLabel({ state: "unknown", key: null })).toBe("Key: unknown");
		expect(keyLabel(null)).toBe("");
	});

	test("status carries name, artists and key, empty when nothing plays (no IPC, no work)", async () => {
		const s = await new DJ().status();
		expect(s.name).toBe("");
		expect(s.artists).toEqual([]);
		expect(s.keyLabel).toBe("");
	});
});
