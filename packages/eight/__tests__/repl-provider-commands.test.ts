/**
 * REPL provider commands against the open provider set (issue #2882).
 *
 * The issue enumerated four gate sites. There was a fifth: `/provider <name>`
 * gated on `PROVIDER_NAMES` and `/providers` enumerated it, so a provider the
 * registry accepted was rejected and invisible on the surface users actually
 * type at. `startREPL` is exported from packages/eight/index.ts - shipped code,
 * not dead code.
 *
 * The last test is the one that stops a sixth site: `PROVIDER_NAMES` is the
 * COMPILED list, never the validity check, and nothing but this test holds its
 * consumers to that.
 */

import { afterAll, afterEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { resetProviderManager } from "../../providers";
import { handleProviderCommands } from "../repl";

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "8gent-repl-"));
const originalPath = process.env.PROVIDERS_SETTINGS_PATH;
const repoRoot = path.resolve(import.meta.dir, "../../..");

/** Point the provider singleton at a throwaway providers.json. */
function declareProviders(providers: Record<string, unknown>): void {
	const file = path.join(tmpDir, `providers-${Math.random().toString(36).slice(2)}.json`);
	fs.writeFileSync(file, JSON.stringify({ providers }, null, 2));
	process.env.PROVIDERS_SETTINGS_PATH = file;
	resetProviderManager();
}

/** Run a REPL command and capture everything it printed. */
async function runCommand(command: string): Promise<string> {
	const lines: string[] = [];
	const original = console.log;
	console.log = (...args: unknown[]) => {
		lines.push(args.map(String).join(" "));
	};
	try {
		await handleProviderCommands(command);
	} finally {
		console.log = original;
	}
	// Strip ANSI so assertions read against the text, not the colour codes.
	// Built from a char code rather than an inline escape: a literal control
	// character in a regex is a lint error, and escaping it here keeps the
	// pattern readable.
	const ansi = new RegExp(`${String.fromCharCode(27)}\\[[0-9;]*m`, "g");
	return lines.join("\n").replace(ansi, "");
}

afterEach(() => {
	if (originalPath === undefined) Reflect.deleteProperty(process.env, "PROVIDERS_SETTINGS_PATH");
	else process.env.PROVIDERS_SETTINGS_PATH = originalPath;
	resetProviderManager();
});

afterAll(() => {
	fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe("/provider <name>", () => {
	test("switches to a provider declared only in providers.json", async () => {
		declareProviders({
			myrig: {
				displayName: "My Rig",
				baseUrl: "http://127.0.0.1:11434",
				compat: "ollama",
				defaultModel: "llama3.2:3b",
			},
		});
		const output = await runCommand("/provider myrig");
		expect(output).toContain("Switched to My Rig");
		expect(output).not.toContain("Unknown provider");
	});

	test("keeps a capitalised declared name working", async () => {
		// A declaration is a hand-written JSON key and may carry capitals. The
		// command has always lowercased its argument for the built-ins.
		declareProviders({ MyRig: { baseUrl: "http://127.0.0.1:11434", compat: "ollama" } });
		const output = await runCommand("/provider MyRig");
		expect(output).toContain("Switched to");
		expect(output).not.toContain("Unknown provider");
	});

	test("still rejects a genuinely unknown provider", async () => {
		declareProviders({ myrig: { baseUrl: "http://127.0.0.1:11434", compat: "ollama" } });
		const output = await runCommand("/provider not-a-provider");
		expect(output).toContain("Unknown provider: not-a-provider");
		// The rejection must offer the OPEN set, so a user who declared a
		// provider can see it in the list they are being pointed at.
		expect(output).toContain("myrig");
		expect(output).toContain("ollama");
	});

	test("built-in switching is unchanged (regression)", async () => {
		declareProviders({});
		const output = await runCommand("/provider ollama");
		expect(output).toContain("Switched to Ollama (Local)");
		// A keyless local provider must not be nagged for a key it never declares.
		expect(output).not.toContain("No API key set");
	});

	test("still warns when a provider that declares a key env var has none", async () => {
		declareProviders({});
		const output = await runCommand("/provider mistral");
		expect(output).toContain("Switched to");
		expect(output).toContain("No API key set");
	});
});

describe("/providers", () => {
	test("lists declared providers alongside the built-ins", async () => {
		declareProviders({
			myrig: { displayName: "My Rig", baseUrl: "http://127.0.0.1:11434", compat: "ollama" },
		});
		const output = await runCommand("/providers");
		expect(output).toContain("My Rig");
		// Enumeration ADDS to the compiled table; it must not replace it.
		expect(output).toContain("Ollama (Local)");
		expect(output).toContain("Anthropic");
	});

	test("shows a keyless declared provider as local, not as missing a key", async () => {
		declareProviders({
			myrig: { displayName: "My Rig", baseUrl: "http://127.0.0.1:11434", compat: "ollama" },
		});
		const line = (await runCommand("/providers")).split("\n").find((l) => l.includes("My Rig"));
		expect(line).toBeDefined();
		expect(line).toContain("local");
		expect(line).not.toContain("no key");
	});
});

describe("PROVIDER_NAMES is the compiled list, never the validity check", () => {
	test("no source file gates or enumerates on PROVIDER_NAMES", () => {
		// This is the guard against a sixth gate site. PROVIDER_NAMES is exported
		// for reference; the moment it is used to decide whether a provider is
		// valid, or to enumerate providers for a user, a declared provider goes
		// invisible again. Ask isKnownProvider() / listProviders() instead.
		const offenders: string[] = [];
		const skip = new Set(["node_modules", "dist", ".git", ".next", "quarantine"]);

		const walk = (dir: string): void => {
			for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
				if (skip.has(entry.name)) continue;
				const full = path.join(dir, entry.name);
				if (entry.isDirectory()) {
					walk(full);
					continue;
				}
				if (!/\.tsx?$/.test(entry.name)) continue;
				const rel = path.relative(repoRoot, full);
				// The registry defines it; this test names it to assert on it.
				if (rel === "packages/providers/index.ts") continue;
				if (rel.endsWith(".test.ts") || rel.endsWith(".test.tsx")) continue;

				for (const [i, line] of fs.readFileSync(full, "utf-8").split("\n").entries()) {
					if (!line.includes("PROVIDER_NAMES")) continue;
					// An import is fine. Using it in a condition or a loop is not.
					if (/^\s*(import|export)\b/.test(line)) continue;
					if (/PROVIDER_NAMES\s*\.\s*(includes|indexOf|some|find)\b/.test(line)) {
						offenders.push(`${rel}:${i + 1} gates on PROVIDER_NAMES`);
					}
					if (/\bfor\b.*\bof\s+PROVIDER_NAMES\b/.test(line)) {
						offenders.push(`${rel}:${i + 1} enumerates PROVIDER_NAMES`);
					}
				}
			}
		};
		walk(path.join(repoRoot, "packages"));
		walk(path.join(repoRoot, "apps"));

		expect(offenders).toEqual([]);
	});
});
