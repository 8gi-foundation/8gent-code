import { describe, expect, it } from "bun:test";
import { requiresDangerousOverride, validateManifest } from "./manifest";

const MIN_VALID = {
	manifestVersion: 1,
	name: "demo-app",
	version: "1.0.0",
	author: "Test",
	description: "A demo app for tests",
	license: "Apache-2.0",
	entry: "src/index.ts",
	capabilities: [],
};

describe("validateManifest", () => {
	it("accepts a minimal valid record", () => {
		const res = validateManifest(MIN_VALID);
		expect(res.ok).toBe(true);
		expect(res.manifest?.name).toBe("demo-app");
	});

	it("rejects manifestVersion other than 1", () => {
		const res = validateManifest({ ...MIN_VALID, manifestVersion: 2 });
		expect(res.ok).toBe(false);
		expect(res.errors.join("\n")).toContain("manifestVersion");
	});

	it("rejects names with uppercase letters", () => {
		const res = validateManifest({ ...MIN_VALID, name: "BadName" });
		expect(res.ok).toBe(false);
		expect(res.errors.join("\n")).toContain("name");
	});

	it("rejects non-SemVer versions", () => {
		const res = validateManifest({ ...MIN_VALID, version: "1.0" });
		expect(res.ok).toBe(false);
		expect(res.errors.join("\n")).toContain("version");
	});

	it("rejects entry paths that traverse parents", () => {
		const res = validateManifest({ ...MIN_VALID, entry: "../escape.ts" });
		expect(res.ok).toBe(false);
	});

	it("rejects unknown capability tiers", () => {
		const res = validateManifest({ ...MIN_VALID, capabilities: ["unknown"] });
		expect(res.ok).toBe(false);
	});

	it("flags dangerous capability for review", () => {
		const res = validateManifest({ ...MIN_VALID, capabilities: ["dangerous"] });
		expect(res.ok).toBe(true);
		expect(requiresDangerousOverride(res.manifest!)).toBe(true);
	});

	it("requires every required field", () => {
		const required = [
			"manifestVersion",
			"name",
			"version",
			"author",
			"description",
			"license",
			"entry",
		];
		for (const field of required) {
			const broken = { ...MIN_VALID } as Record<string, unknown>;
			delete broken[field];
			const res = validateManifest(broken);
			expect(res.ok).toBe(false);
		}
	});
});
