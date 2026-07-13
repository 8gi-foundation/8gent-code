/**
 * Tests for the skill manifest spec + validator (issue #2760, Step 1).
 *
 * Covers:
 *   - frontmatter parses version / modelsRequired / entryPoints / author / license
 *   - a minimal (name + description) skill validates with warnings, never errors
 *   - malformed version / capabilities / models / entry points are hard errors
 *   - an unsafe name (path traversal, whitespace) blocks
 *   - a self-loop capability (required AND granted) blocks
 *   - unknown-but-well-formed capability is a warning, not an error
 *   - installSkill rejects a malformed manifest before widening capabilities
 *   - a clean manifest still installs (backward compatible with #2091)
 */

import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SkillManager, buildManifest, validateManifest } from "./index.js";
import type { SkillManifest } from "./manifest.js";

function manifest(overrides: Partial<SkillManifest> = {}): SkillManifest {
	return {
		name: "deploy",
		description: "Deploy the app",
		version: "1.0.0",
		requiredCapabilities: [],
		grantedCapabilities: [],
		modelsRequired: [],
		entryPoints: [],
		author: "jamesspalding",
		license: "Apache-2.0",
		...overrides,
	};
}

describe("validateManifest", () => {
	it("accepts a complete, well-formed manifest with no warnings", () => {
		const r = validateManifest(
			manifest({
				requiredCapabilities: ["network"],
				grantedCapabilities: ["filesystem-write"],
				modelsRequired: ["eight-1.0-q3:14b"],
				entryPoints: ["/deploy"],
			}),
		);
		expect(r.ok).toBe(true);
		expect(r.errors).toEqual([]);
		expect(r.warnings).toEqual([]);
	});

	it("accepts a minimal skill with only name + description (warnings, no errors)", () => {
		const r = validateManifest({
			name: "commit",
			description: "Git commit",
			requiredCapabilities: [],
			grantedCapabilities: [],
			modelsRequired: [],
			entryPoints: [],
		});
		expect(r.ok).toBe(true);
		expect(r.errors).toEqual([]);
		// version/author/license missing -> recommendations only.
		expect(r.warnings.length).toBeGreaterThan(0);
	});

	it("rejects a missing name", () => {
		const r = validateManifest(manifest({ name: "" }));
		expect(r.ok).toBe(false);
		expect(r.errors.some((e) => e.includes("name is required"))).toBe(true);
	});

	it("rejects an unsafe name (path traversal / whitespace)", () => {
		expect(validateManifest(manifest({ name: "../evil" })).ok).toBe(false);
		expect(validateManifest(manifest({ name: "a/b" })).ok).toBe(false);
		expect(validateManifest(manifest({ name: "bad name" })).ok).toBe(false);
	});

	it("rejects a non-semver version", () => {
		const r = validateManifest(manifest({ version: "v1" }));
		expect(r.ok).toBe(false);
		expect(r.errors.some((e) => e.includes("semver"))).toBe(true);
	});

	it("accepts semver with a prerelease tag", () => {
		expect(validateManifest(manifest({ version: "2.3.1-rc.1" })).ok).toBe(true);
	});

	it("rejects a malformed capability token", () => {
		const r = validateManifest(manifest({ grantedCapabilities: ["Net Work"] }));
		expect(r.ok).toBe(false);
		expect(r.errors.some((e) => e.includes("grantedCapability"))).toBe(true);
	});

	it("warns on a well-formed but unknown capability without blocking", () => {
		const r = validateManifest(manifest({ grantedCapabilities: ["quantum-teleport"] }));
		expect(r.ok).toBe(true);
		expect(r.warnings.some((w) => w.includes("quantum-teleport"))).toBe(true);
	});

	it("rejects a capability that is both required and granted", () => {
		const r = validateManifest(
			manifest({ requiredCapabilities: ["network"], grantedCapabilities: ["network"] }),
		);
		expect(r.ok).toBe(false);
		expect(r.errors.some((e) => e.includes("both required and granted"))).toBe(true);
	});

	it("rejects a model with whitespace", () => {
		const r = validateManifest(manifest({ modelsRequired: ["gpt 4"] }));
		expect(r.ok).toBe(false);
		expect(r.errors.some((e) => e.includes("modelsRequired"))).toBe(true);
	});

	it("accepts a provider:model coordinate", () => {
		expect(validateManifest(manifest({ modelsRequired: ["ollama:qwen2.5"] })).ok).toBe(true);
	});

	it("accepts both /slash and bare entry points, rejects a malformed one", () => {
		expect(validateManifest(manifest({ entryPoints: ["/deploy", "ship"] })).ok).toBe(true);
		expect(validateManifest(manifest({ entryPoints: ["/bad name"] })).ok).toBe(false);
	});
});

describe("frontmatter -> manifest projection", () => {
	let dir: string;
	let mgr: SkillManager;

	beforeEach(() => {
		dir = mkdtempSync(join(tmpdir(), "manifest-test-"));
		mgr = new SkillManager(dir);
	});

	afterEach(() => {
		rmSync(dir, { recursive: true, force: true });
	});

	it("parses version, modelsRequired, entryPoints, author, license from frontmatter", async () => {
		writeFileSync(
			join(dir, "deploy.md"),
			`---
name: deploy
description: Deploy the app
version: 1.2.0
requiredCapabilities: [network]
grantedCapabilities: [filesystem-write]
modelsRequired: [eight-1.0-q3:14b, ollama:qwen2.5]
entryPoints: [/deploy, /ship]
author: jamesspalding
license: Apache-2.0
---
# Deploy
Do the deploy.
`,
		);
		await mgr.loadSkills();
		const skill = mgr.getSkill("deploy");
		expect(skill).toBeDefined();
		const m = buildManifest(skill!);
		expect(m.version).toBe("1.2.0");
		expect(m.modelsRequired).toEqual(["eight-1.0-q3:14b", "ollama:qwen2.5"]);
		expect(m.entryPoints).toEqual(["/deploy", "/ship"]);
		expect(m.author).toBe("jamesspalding");
		expect(m.license).toBe("Apache-2.0");
		expect(validateManifest(m).ok).toBe(true);
	});
});

describe("installSkill manifest gate", () => {
	let dir: string;
	let mgr: SkillManager;

	beforeEach(() => {
		dir = mkdtempSync(join(tmpdir(), "manifest-install-"));
		mgr = new SkillManager(dir);
	});

	afterEach(() => {
		rmSync(dir, { recursive: true, force: true });
	});

	it("blocks install of a skill whose manifest fails validation", async () => {
		writeFileSync(
			join(dir, "broken.md"),
			`---
name: broken
description: Bad version
version: not-a-version
---
# Broken
`,
		);
		await mgr.loadSkills();
		const result = mgr.installSkill("broken");
		expect(result.ok).toBe(false);
		if (!result.ok) {
			expect(result.reason).toContain("invalid skill manifest");
		}
		expect(mgr.isInstalled("broken")).toBe(false);
	});

	it("installs a clean skill and still widens capabilities (backward compatible)", async () => {
		writeFileSync(
			join(dir, "reader.md"),
			`---
name: reader
description: Reads files
version: 1.0.0
grantedCapabilities: [network]
---
# Reader
`,
		);
		await mgr.loadSkills();
		const result = mgr.installSkill("reader");
		expect(result.ok).toBe(true);
		if (result.ok) {
			expect(result.granted).toContain("network");
		}
		expect(mgr.hasCapability("network")).toBe(true);
	});
});
