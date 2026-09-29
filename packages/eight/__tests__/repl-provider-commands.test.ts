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
const originalPath = process.env.EIGHT_PROVIDERS_SETTINGS_PATH;
const repoRoot = path.resolve(import.meta.dir, "../../..");

/** Ollama for the discovery test. Skipped-with-a-reason when it is not up. */
const LIVE_OLLAMA = process.env.DECLARED_TEST_BASE_URL || "http://127.0.0.1:11434";

/** Probe at module scope: skipIf is evaluated before any hook runs. */
const [live, liveModel] = await (async (): Promise<[boolean, string]> => {
	try {
		const res = await fetch(`${LIVE_OLLAMA}/api/tags`, { signal: AbortSignal.timeout(3000) });
		if (!res.ok) return [false, ""];
		const tags = (await res.json()) as { models?: { name?: string }[] };
		const names = (tags.models ?? []).map((m) => m.name ?? "").filter(Boolean);
		return [names.length > 0, names[0] ?? ""];
	} catch {
		return [false, ""];
	}
})();

/** Point the provider singleton at a throwaway providers.json. */
function declareProviders(providers: Record<string, unknown>): void {
	const file = path.join(tmpDir, `providers-${Math.random().toString(36).slice(2)}.json`);
	fs.writeFileSync(file, JSON.stringify({ providers }, null, 2));
	process.env.EIGHT_PROVIDERS_SETTINGS_PATH = file;
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
	if (originalPath === undefined)
		Reflect.deleteProperty(process.env, "EIGHT_PROVIDERS_SETTINGS_PATH");
	else process.env.EIGHT_PROVIDERS_SETTINGS_PATH = originalPath;
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

describe("/provider models", () => {
	test("discovers models for a declaration that lists none", async () => {
		// The documented workflow: declare a baseUrl and nothing else. Before this
		// was wired, /provider models printed an empty list forever and no shipped
		// surface would ever populate it.
		declareProviders({
			myrig: { baseUrl: LIVE_OLLAMA, compat: "ollama" },
		});
		await runCommand("/provider myrig");
		const output = await runCommand("/provider models");
		if (!live) {
			// No endpoint on this host: it must fail loudly and not hang or throw.
			expect(output).toContain("discovery failed");
			return;
		}
		expect(output).toContain("discovering...");
		expect(output).toContain(liveModel);
	}, 30_000);

	test("a declared endpoint that never answers does not hang the REPL", async () => {
		// 203.0.113.0/24 is TEST-NET-3: reserved, routable-looking, black-holes.
		// This is the stale-LAN-IP case the feature invites.
		declareProviders({
			ghost: { baseUrl: "http://203.0.113.1:11434", compat: "ollama" },
		});
		await runCommand("/provider ghost");
		const started = Date.now();
		const output = await runCommand("/provider models");
		const elapsed = Date.now() - started;
		expect(output).toContain("discovery failed");
		// Bounded by DISCOVERY_TIMEOUT_MS, not left to hang forever.
		expect(elapsed).toBeLessThan(15_000);
	}, 30_000);

	test("a provider with a static model list does not call out", async () => {
		declareProviders({});
		await runCommand("/provider ollama");
		const output = await runCommand("/provider models");
		expect(output).not.toContain("discovering...");
		expect(output).not.toContain("discovery failed");
	});
});

describe("/provider key", () => {
	test("refuses to store a key for a keyless declared provider", async () => {
		declareProviders({
			myrig: { displayName: "My Rig", baseUrl: "http://127.0.0.1:11434", compat: "ollama" },
		});
		await runCommand("/provider myrig");
		const output = await runCommand("/provider key sk-should-not-be-stored");
		expect(output).toContain("doesn't need an API key");
		expect(output).not.toContain("API key saved");
	});

	test("reports the real settings path, not a hardcoded one", async () => {
		declareProviders({});
		await runCommand("/provider mistral");
		const output = await runCommand("/provider key sk-test-value");
		expect(output).toContain("API key saved");
		// The path is redirectable; printing "~/.8gent/providers.json" would be a
		// lie whenever EIGHT_DATA_DIR is set.
		expect(output).toContain(process.env.EIGHT_PROVIDERS_SETTINGS_PATH as string);
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
					// Skip an import/re-export STATEMENT only. A bare `^\s*export\b`
					// also skipped every exported one-line declaration, which is
					// exactly how a gate gets written:
					//   export const isValid = (n) => PROVIDER_NAMES.includes(n);
					// Requiring a binding form after the keyword keeps imports
					// exempt without opening that hole.
					if (/^\s*(import|export)\s*(\{|\*|type\b|default\b)/.test(line)) continue;
					// The lookbehind stops a future BUILTIN_PROVIDER_NAMES (or any
					// other *_PROVIDER_NAMES) from false-positiving on this rule.
					if (/(?<![A-Z_])PROVIDER_NAMES\s*\.\s*(includes|indexOf|some|find|filter)\b/.test(line)) {
						offenders.push(`${rel}:${i + 1} gates on PROVIDER_NAMES`);
					}
					// .map is how a picker gets rendered in this codebase, which is
					// the enumeration regression this rule exists to catch.
					if (
						/(?<![A-Z_])PROVIDER_NAMES\s*\.\s*(map|forEach)\b/.test(line) ||
						/\bof\s+PROVIDER_NAMES\b/.test(line)
					) {
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
