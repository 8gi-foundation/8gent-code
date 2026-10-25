import { describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";
import { LOCAL_RUNTIME_UNREACHABLE } from "../local-runtime-hint";

describe("8gent run: local runtime unreachable (#4915)", () => {
	test("the error points at the llama-server provider, not a system install", () => {
		expect(LOCAL_RUNTIME_UNREACHABLE).not.toMatch(/ollama serve/i);
		expect(LOCAL_RUNTIME_UNREACHABLE).not.toMatch(/brew install/i);
		expect(LOCAL_RUNTIME_UNREACHABLE).toContain("/provider llama-server");
	});

	test("the provider fallback hint is kept", () => {
		expect(LOCAL_RUNTIME_UNREACHABLE).toContain("--provider openrouter");
	});

	test("it does not send people to /judge install, which needs Ollama on desktop", () => {
		expect(LOCAL_RUNTIME_UNREACHABLE).not.toContain("/judge install");
	});

	test("the named provider is a real one", () => {
		const src = fs.readFileSync(path.join(import.meta.dir, "../../ai/providers.ts"), "utf8");
		expect(src).toContain('"llama-server"');
	});

	test("index.ts prints that constant and no inline install hint", () => {
		const src = fs.readFileSync(path.join(import.meta.dir, "../index.ts"), "utf8");
		expect(src).toContain("console.error(LOCAL_RUNTIME_UNREACHABLE)");
		expect(src).not.toMatch(/`ollama serve`/);
	});
});
