/**
 * Per-officer EXECUTION harness resolution tests (packages/table/harness-config.ts,
 * packages/table/helm-bridge.ts's bindOfficerHarness).
 *
 * resolveHarness() reads its config path fresh on every call (deliberately not
 * cached at module scope - see harness-config.ts), so these tests point it at a
 * scratch file per test via TABLE_HARNESS_CONFIG (a test-only override - Bun's
 * os.homedir() does not track a runtime-reassigned $HOME, so a direct path
 * override is used instead of writing into the real, machine-wide
 * ~/.8gent/table-harness.json). Never touches that real file.
 */
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { OFFICERS } from "../officers";
import { resolveHarness } from "../harness-config";
import { bindOfficerHarness, type HelmProposal } from "../helm-bridge";

let tmpDir: string;
let configFile: string;
let realOverride: string | undefined;

beforeEach(() => {
	tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "table-harness-"));
	configFile = path.join(tmpDir, "table-harness.json");
	realOverride = process.env.TABLE_HARNESS_CONFIG;
	process.env.TABLE_HARNESS_CONFIG = configFile;
});

afterEach(() => {
	if (realOverride === undefined) delete process.env.TABLE_HARNESS_CONFIG;
	else process.env.TABLE_HARNESS_CONFIG = realOverride;
	try {
		fs.rmSync(tmpDir, { recursive: true, force: true });
	} catch {
		/* best-effort cleanup */
	}
});

function writeConfig(obj: unknown): void {
	fs.writeFileSync(configFile, JSON.stringify(obj));
}

describe("resolveHarness", () => {
	it("known officer + no config file -> coded default", () => {
		// configFile does not exist yet in this test.
		expect(resolveHarness("8TO")).toEqual(OFFICERS["8TO"].harness);
		expect(resolveHarness("8EO")?.kind).toBe("claude");
	});

	it("known officer + valid config override -> override wins", () => {
		writeConfig({ "8TO": { kind: "pi" } });
		expect(resolveHarness("8TO")?.kind).toBe("pi");
		// An officer with no entry in the file still falls back to its coded default.
		expect(resolveHarness("8EO")?.kind).toBe("claude");
	});

	it("config override can also carry a model and skills", () => {
		writeConfig({ "8DO": { kind: "cursor-agent", model: "sonnet-4" } });
		const h = resolveHarness("8DO");
		expect(h?.kind).toBe("cursor-agent");
		expect(h?.model).toBe("sonnet-4");
	});

	it("known officer + invalid/unknown kind in config -> coded fallback + warning", () => {
		writeConfig({ "8SO": { kind: "aider" } });
		const warnings: unknown[][] = [];
		const origWarn = console.warn;
		console.warn = (...args: unknown[]) => warnings.push(args);
		try {
			const h = resolveHarness("8SO");
			expect(h?.kind).toBe(OFFICERS["8SO"].harness.kind); // "shell"
		} finally {
			console.warn = origWarn;
		}
		expect(warnings.length).toBe(1);
		expect(String(warnings[0][0])).toContain("[table-harness]");
		expect(String(warnings[0][0])).toContain("8SO");
	});

	it("goose is not a valid kind (blocked, broken CLI on this machine)", () => {
		writeConfig({ "8GO": { kind: "goose" } });
		const origWarn = console.warn;
		console.warn = () => {};
		try {
			expect(resolveHarness("8GO")?.kind).not.toBe("goose");
			expect(resolveHarness("8GO")?.kind).toBe(OFFICERS["8GO"].harness.kind); // "pi"
		} finally {
			console.warn = origWarn;
		}
	});

	it("malformed JSON file falls back to coded default, never throws", () => {
		fs.writeFileSync(configFile, "{ not json");
		expect(() => resolveHarness("8TO")).not.toThrow();
		expect(resolveHarness("8TO")?.kind).toBe(OFFICERS["8TO"].harness.kind);
	});

	it("unknown officer code with no coded default -> undefined", () => {
		expect(resolveHarness("9ZZ")).toBeUndefined();
	});
});

describe("bindOfficerHarness", () => {
	const baseProposal: HelmProposal = { kind: "shell", cwd: "~/8gent-code", command: "git status" };

	it("overrides a known officer's parsed kind with their bound harness", () => {
		// The model's marker always says kind=shell; the officer's real harness wins.
		const out = bindOfficerHarness("8TO", baseProposal);
		expect(out.kind).toBe("codex");
		expect(out.cwd).toBe(baseProposal.cwd);
		expect(out.command).toBe(baseProposal.command);
	});

	it("carries a config-file override through the same path", () => {
		writeConfig({ "8TO": { kind: "opencode" } });
		const out = bindOfficerHarness("8TO", baseProposal);
		expect(out.kind).toBe("opencode");
	});

	it("unknown officer code leaves the parsed proposal unchanged", () => {
		const out = bindOfficerHarness("9ZZ", baseProposal);
		expect(out).toEqual(baseProposal);
	});
});
