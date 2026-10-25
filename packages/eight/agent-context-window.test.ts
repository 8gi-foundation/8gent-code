/**
 * #5035: each tab's 8gent has its own context window. The host pushes what the
 * provider's models list said (detected) and what the owner set (override); the
 * override wins, a reset falls back to detected and then to the constructor's
 * window, and compaction reads the per-tab value.
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { removeDir } from "../../tests/temp-dirs";
import type { Agent as AgentT } from "./agent";

let Agent: typeof import("./agent").Agent;
let home: string;
let repo: string;
const saved: Record<string, string | undefined> = {};

beforeAll(async () => {
	home = mkdtempSync(join(tmpdir(), "ctx5035-home-"));
	repo = mkdtempSync(join(tmpdir(), "ctx5035-repo-"));
	mkdirSync(join(home, ".8gent", "memory"), { recursive: true });
	for (const [k, v] of Object.entries({
		HOME: home,
		EIGHT_DATA_DIR: join(home, ".8gent"),
		"8GENT_TWO_STAGE_COMPACT": "0",
	})) {
		saved[k] = process.env[k];
		process.env[k] = v;
	}
	({ Agent } = await import("./agent"));
});

afterAll(() => {
	for (const [k, v] of Object.entries(saved)) {
		if (v === undefined) delete process.env[k];
		else process.env[k] = v;
	}
	removeDir(home);
	removeDir(repo);
});

function build(model: string): AgentT {
	return new Agent({
		model,
		runtime: "openrouter",
		apiKey: "stub-key",
		workingDirectory: repo,
		maxTurns: 2,
	} as ConstructorParameters<typeof Agent>[0]);
}

/** A history of roughly `tokens` tokens (the compactor estimates four characters a token). */
function history(tokens: number) {
	return [
		{ role: "system", content: "s" },
		{ role: "user", content: "u".repeat(tokens * 4) },
	];
}

type Compactable = { compaction: { shouldCompact: (m: unknown[]) => boolean } };
const wantsCompaction = (a: AgentT, tokens: number) =>
	(a as unknown as Compactable).compaction.shouldCompact(history(tokens));

describe("#5035 per-tab window on the 8gent", () => {
	test("a detected window replaces the fixed fallback", () => {
		const a = build("m-detected");
		const base = a.getContextWindow();
		a.setContextWindow({ detected: 1_000_000 });
		expect(a.getContextWindow()).toBe(1_000_000);
		expect(base).not.toBe(1_000_000);
	});

	test("an override beats the detected value, and reset returns to detected", () => {
		const a = build("m-override");
		a.setContextWindow({ detected: 200_000 });
		a.setContextWindow({ override: 64_000 });
		expect(a.getContextWindow()).toBe(64_000);
		// A later detection (a model change) does not undo the owner's choice.
		a.setContextWindow({ detected: 1_000_000 });
		expect(a.getContextWindow()).toBe(64_000);
		a.setContextWindow({ override: null });
		expect(a.getContextWindow()).toBe(1_000_000);
	});

	test("with neither, the window falls back to what the 8gent started with", () => {
		const a = build("m-reset");
		const base = a.getContextWindow();
		a.setContextWindow({ detected: 500_000 });
		a.setContextWindow({ detected: null });
		expect(a.getContextWindow()).toBe(base);
	});

	test("junk is ignored, never a zero window", () => {
		const a = build("m-junk");
		const base = a.getContextWindow();
		a.setContextWindow({ detected: 0, override: Number.NaN });
		expect(a.getContextWindow()).toBe(base);
	});

	test("compaction reads the per-tab value: the same history compacts on one tab and not the other", () => {
		const small = build("m-small");
		const large = build("m-large");
		small.setContextWindow({ override: 8_000 });
		large.setContextWindow({ detected: 1_000_000 });
		expect(wantsCompaction(small, 7_000)).toBe(true);
		expect(wantsCompaction(large, 7_000)).toBe(false);
		// Resetting the small tab to a larger override stops its compaction.
		small.setContextWindow({ override: 1_000_000 });
		expect(wantsCompaction(small, 7_000)).toBe(false);
	});

	test("two tabs keep different windows", () => {
		const a = build("m-a");
		const b = build("m-b");
		a.setContextWindow({ detected: 128_000 });
		b.setContextWindow({ detected: 1_000_000 });
		expect(a.getContextWindow()).toBe(128_000);
		expect(b.getContextWindow()).toBe(1_000_000);
	});
});
