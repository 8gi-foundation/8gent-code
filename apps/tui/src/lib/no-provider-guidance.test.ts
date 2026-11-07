import { describe, expect, test } from "bun:test";
import {
	guidanceCopy,
	guidanceText,
	providerKeyStatus,
	unreachableLine,
} from "./no-provider-guidance.js";

describe("the phone's NO MODEL card", () => {
	const termux = { PREFIX: "/data/data/com.termux/files/usr" };

	test("on Termux it offers llama.cpp on the phone first, then OpenRouter free", () => {
		const copy = guidanceCopy("linux", termux);
		expect(copy.paths.map((p) => p.n)).toEqual(["1", "2"]);
		const [local, hosted] = copy.paths;
		expect(local?.title).toMatch(/on this phone/);
		expect(local?.title).toMatch(/nothing leaves the phone/);
		expect(local?.steps[0]).toBe("pkg install llama-cpp");
		expect(local?.steps[1]).toMatch(/^llama-server -hf \S+/);
		expect(local?.steps[2]).toMatch(/\/provider llama-server$/);
		expect(hosted?.title).toMatch(/leave the phone/);
		expect(hosted?.steps.join("\n")).toContain("8gent keys set openrouter");
		expect(hosted?.steps.join("\n")).toContain("/model auto:free");
	});

	test("it never names Ollama on a phone", () => {
		const text = JSON.stringify(guidanceCopy("android" as NodeJS.Platform, {}));
		expect(text.toLowerCase()).not.toContain("ollama");
	});

	test("a laptop keeps the Ollama card", () => {
		expect(JSON.stringify(guidanceCopy("darwin", {}))).toContain("ollama");
	});

	test("every shell line pastes as it stands: the note is a # comment", () => {
		for (const step of guidanceCopy("linux", termux).paths[0]?.steps ?? []) {
			const code = step.split("#")[0] ?? "";
			expect(code).not.toContain(" ");
		}
	});
});

describe("providerKeyStatus", () => {
	const lookup =
		(keys: Record<string, { needsKey: boolean; hasKey: boolean }>) => (name: string) => {
			const hit = keys[name];
			if (!hit) throw new Error("unknown");
			return hit;
		};

	test("openrouter-free uses the OpenRouter key", () => {
		const l = lookup({ openrouter: { needsKey: true, hasKey: false } });
		expect(providerKeyStatus("openrouter-free", l)).toBe("missing");
		expect(providerKeyStatus("openrouter", l)).toBe("missing");
	});

	test("key present", () => {
		expect(providerKeyStatus("groq", lookup({ groq: { needsKey: true, hasKey: true } }))).toBe(
			"present",
		);
	});

	test("local providers and lookup failures need no key", () => {
		expect(providerKeyStatus("ollama", lookup({}))).toBe("not-needed");
		expect(providerKeyStatus("mystery", lookup({}))).toBe("not-needed");
	});

	test("real registry: openrouter needs OPENROUTER_API_KEY", () => {
		const saved = process.env.OPENROUTER_API_KEY;
		delete process.env.OPENROUTER_API_KEY;
		try {
			expect(["missing", "present"]).toContain(providerKeyStatus("openrouter"));
			process.env.OPENROUTER_API_KEY = "test-key-not-real";
			expect(providerKeyStatus("openrouter")).toBe("present");
		} finally {
			if (saved === undefined) delete process.env.OPENROUTER_API_KEY;
			else process.env.OPENROUTER_API_KEY = saved;
		}
	});
});

describe("unreachableLine", () => {
	test("names the engine and its address, says it once", () => {
		expect(unreachableLine("Ollama", "127.0.0.1:11434", "not reachable")).toBe(
			"Ollama at 127.0.0.1:11434 did not answer.",
		);
		expect(unreachableLine("LM Studio", "localhost:1234", "no answer within 3s")).toBe(
			"LM Studio at localhost:1234 did not answer within 3s.",
		);
		expect(unreachableLine("Ollama", "127.0.0.1:11434", "http 500")).toBe(
			"Ollama at 127.0.0.1:11434 answered with http 500.",
		);
		expect(unreachableLine("Ollama", "127.0.0.1:11434", "no models")).toBe(
			"Ollama at 127.0.0.1:11434 has no models yet.",
		);
	});
});

describe("guidanceText at a narrow width", () => {
	test("wrapped rows hang under their own line, none lands flush left", () => {
		const text = guidanceText(
			guidanceCopy("darwin"),
			"Ollama at http://127.0.0.1:11434 did not answer.",
			40,
		);
		for (const row of text.split("\n")) {
			expect(row.length <= 40 || !row.includes(" ")).toBe(true);
		}
		const flush = text.split("\n").filter((r) => !/^( |NO MODEL|Ollama at|\d\. )/.test(r));
		expect(flush).toEqual([]);
	});
	test("a wide terminal leaves the text as it was", () => {
		const copy = guidanceCopy("darwin");
		expect(guidanceText(copy, null, 200)).toBe(guidanceText(copy, null));
	});
});
