import { describe, expect, test } from "bun:test";
import { keyLooksUsable, noModelMessage } from "./no-model-message";

const base = {
	displayName: "MiniMax",
	keyEnv: "MINIMAX_API_KEY",
	pickHint: "Pass --model <name>.",
};

describe("noModelMessage", () => {
	test("no key names the key and the fix, not the model list", () => {
		const m = noModelMessage({ ...base, key: null });
		expect(m).toBe(
			"No MiniMax key found. Run `8gent keys set minimax` to add MINIMAX_API_KEY, or `8gent keys` to edit the file.",
		);
		expect(m).not.toContain("list");
	});
	test("a one-character key is unusable and is never printed", () => {
		const m = noModelMessage({ ...base, key: "Z" });
		expect(m).toContain("MINIMAX_API_KEY");
		expect(m).toContain("1 character");
		expect(m).not.toContain('"Z"');
		expect(keyLooksUsable("Z")).toBe(false);
		expect(keyLooksUsable("fake-key-0123456789")).toBe(true);
	});
	test("401 says the key was rejected", () => {
		const m = noModelMessage({
			...base,
			key: "fake-key-0123456789",
			err: new Error("Model discovery failed for https://x/models: 401 {}"),
		});
		expect(m).toContain("rejected the key (HTTP 401)");
	});
	test("a network failure keeps the list wording and the pick hint", () => {
		const m = noModelMessage({
			...base,
			key: "fake-key-0123456789",
			err: new Error("fetch failed"),
		});
		expect(m).toContain("could not reach its model list");
		expect(m).toContain("Pass --model <name>.");
	});
});

describe("noModelMessage scrubs upstream error text (8SO #4681)", () => {
	test("a server echo of the key is cut", () => {
		const key = "fake-key-0123456789abcdef";
		const m = noModelMessage({ ...base, key, err: new Error(`bad key ${key} sent`) });
		expect(m).not.toContain(key);
		expect(m).toContain("[key]");
	});
	test("URL userinfo is cut", () => {
		const m = noModelMessage({
			...base,
			key: "fake-key-0123456789",
			err: new Error("fetch failed for https://bob:hunter2secret@llm.local/v1/models"),
		});
		expect(m).not.toContain("hunter2secret");
		expect(m).toContain("https://llm.local/v1/models");
	});
});
