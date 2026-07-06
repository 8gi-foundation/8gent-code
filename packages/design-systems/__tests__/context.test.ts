/**
 * Tests for the universal design-context resolver (packages/design-systems/context.ts).
 *
 * Hermetic: EIGHT_DESIGN_DB points the resolver at temp DBs we control, so the
 * suite never depends on the repo's data/design-systems.db. Tests run in order
 * within this file: the fail-closed case runs first (it never sets the resolver's
 * ready-cache), then the happy path re-points initDatabase() at a seeded DB.
 *
 * Spec success metrics covered: token parity (byte-identical), determinism,
 * designSystemId metadata, fail-closed on an empty DB.
 */

import { beforeAll, describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { generateCssVariables } from "../query";
import {
	DesignContextUnavailable,
	designPromptBlock,
	resolveDesignContext,
} from "../context";
import { seedDatabase } from "../seed";
import { initDatabase } from "../db";

let emptyDbPath: string;
let seededDbPath: string;

beforeAll(() => {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "ds-ctx-"));
	// An existing-but-empty DB (schema only, 0 systems) to exercise fail-closed.
	emptyDbPath = path.join(root, "empty.db");
	initDatabase(emptyDbPath);
	// A fully seeded DB for the happy path.
	seededDbPath = path.join(root, "seeded.db");
	seedDatabase(seededDbPath);
});

describe("resolveDesignContext", () => {
	test("fail-closed: throws DesignContextUnavailable on an empty DB", () => {
		process.env.EIGHT_DESIGN_DB = emptyDbPath;
		expect(() => resolveDesignContext({ projectType: "saas" })).toThrow(
			DesignContextUnavailable,
		);
	});

	test("resolves a real system for a project type", () => {
		process.env.EIGHT_DESIGN_DB = seededDbPath;
		const ctx = resolveDesignContext({ projectType: "saas" });
		expect(ctx.systemId).toBeTruthy();
		expect(ctx.name).toBeTruthy();
		expect(ctx.cssVariables).toContain(":root");
		expect(Object.keys(ctx.hexPalette).length).toBeGreaterThan(0);
	});

	test("token parity: cssVariables is byte-identical to generateCssVariables(systemId)", () => {
		process.env.EIGHT_DESIGN_DB = seededDbPath;
		const ctx = resolveDesignContext({ systemId: "vercel" });
		expect(ctx.systemId).toBe("vercel");
		expect(ctx.cssVariables).toBe(generateCssVariables("vercel"));
	});

	test("deterministic: same hint resolves to the same systemId", () => {
		process.env.EIGHT_DESIGN_DB = seededDbPath;
		const a = resolveDesignContext({ projectType: "gaming" }).systemId;
		const b = resolveDesignContext({ projectType: "gaming" }).systemId;
		expect(a).toBe(b);
	});

	test("explicit systemId wins over project type", () => {
		process.env.EIGHT_DESIGN_DB = seededDbPath;
		const ctx = resolveDesignContext({ systemId: "cyberpunk", projectType: "saas" });
		expect(ctx.systemId).toBe("cyberpunk");
	});

	test("promptBlock names the system and embeds the primary hex", () => {
		process.env.EIGHT_DESIGN_DB = seededDbPath;
		const ctx = resolveDesignContext({ systemId: "vercel" });
		const block = designPromptBlock(ctx);
		expect(block).toContain(ctx.name);
		expect(block).toContain(ctx.hexPalette.primary);
		expect(block).toContain("Use ONLY this design system");
	});
});
