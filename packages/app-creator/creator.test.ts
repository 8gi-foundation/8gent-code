import { describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp, draftApp } from "./creator.js";
import { findApp, listApps, runApp } from "./loader.js";
import { parseManifestFile, validateManifest } from "./manifest.js";

function tmpRoot(): string {
	return mkdtempSync(join(tmpdir(), "app-creator-"));
}

describe("manifest validation", () => {
	test("accepts well-formed manifest", () => {
		const v = validateManifest({
			name: "todo-list",
			description: "A tiny todo list app for testing",
			version: "0.1.0",
			entry: "index.ts",
			capabilities: ["read", "write"],
			publish: "personal",
		});
		expect(v.ok).toBe(true);
		expect(v.manifest?.name).toBe("todo-list");
	});

	test("rejects bad slug", () => {
		const v = validateManifest({
			name: "Bad Name!",
			description: "should fail because slug is invalid",
			version: "0.1.0",
		});
		expect(v.ok).toBe(false);
		expect(v.errors.some((e) => e.includes("name"))).toBe(true);
	});

	test("rejects bad version", () => {
		const v = validateManifest({
			name: "ok-name",
			description: "should fail on version field only",
			version: "not-a-version",
		});
		expect(v.ok).toBe(false);
		expect(v.errors.some((e) => e.includes("version"))).toBe(true);
	});

	test("parseManifestFile rejects invalid JSON", () => {
		const v = parseManifestFile("{not json");
		expect(v.ok).toBe(false);
		expect(v.errors[0]).toContain("not valid JSON");
	});

	test("rejects unknown capability", () => {
		const v = validateManifest({
			name: "okname",
			description: "test description here",
			version: "1.0.0",
			capabilities: ["nuclear-launch"],
		});
		expect(v.ok).toBe(false);
	});
});

describe("draftApp", () => {
	test("produces all four scaffold files", () => {
		const draft = draftApp({
			name: "demo-app",
			description: "Demo app used by tests",
			capabilities: ["read"],
		});
		expect(draft.errors).toEqual([]);
		expect(Object.keys(draft.files).sort()).toEqual(
			["README.md", "SKILL.md", "index.ts", "manifest.json", "tests/index.test.ts"].sort(),
		);
		expect(draft.files["SKILL.md"]).toContain("describe -> generate -> test -> refine");
		expect(draft.files["index.ts"]).toContain("export async function run");
	});

	test("does not write to disk without approval", () => {
		const root = tmpRoot();
		try {
			const r = createApp({
				name: "noapprove",
				description: "Should not be persisted",
				appsRoot: root,
			});
			expect(r.persisted).toBe(false);
			expect(existsSync(join(root, "noapprove"))).toBe(false);
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});
});

describe("createApp", () => {
	test("scaffolds and persists when approved", () => {
		const root = tmpRoot();
		try {
			const r = createApp({
				name: "scaffold-test",
				description: "Scaffold smoke test",
				capabilities: ["read", "bash"],
				appsRoot: root,
				approved: true,
			});
			expect(r.persisted).toBe(true);
			expect(r.errors).toEqual([]);
			const dir = join(root, "scaffold-test");
			expect(existsSync(join(dir, "manifest.json"))).toBe(true);
			expect(existsSync(join(dir, "index.ts"))).toBe(true);
			expect(existsSync(join(dir, "SKILL.md"))).toBe(true);
			expect(existsSync(join(dir, "tests/index.test.ts"))).toBe(true);
			const m = JSON.parse(readFileSync(join(dir, "manifest.json"), "utf-8"));
			expect(m.name).toBe("scaffold-test");
			expect(m.capabilities).toEqual(["read", "bash"]);
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});

	test("refuses to overwrite an existing app", () => {
		const root = tmpRoot();
		try {
			createApp({
				name: "twice",
				description: "first write",
				appsRoot: root,
				approved: true,
			});
			const r2 = createApp({
				name: "twice",
				description: "second write should fail",
				appsRoot: root,
				approved: true,
			});
			expect(r2.persisted).toBe(false);
			expect(r2.errors[0]).toContain("already exists");
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});

	test("listApps and findApp see scaffolded apps", () => {
		const root = tmpRoot();
		try {
			createApp({
				name: "alpha",
				description: "first app",
				appsRoot: root,
				approved: true,
			});
			createApp({
				name: "beta",
				description: "second app",
				appsRoot: root,
				approved: true,
			});
			const apps = listApps(root);
			expect(apps.map((a) => a.manifest.name)).toEqual(["alpha", "beta"]);
			const found = findApp("alpha", root);
			expect(found?.manifest.name).toBe("alpha");
			expect(findApp("missing", root)).toBeNull();
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});
});

describe("runApp", () => {
	test("loads and executes a scaffolded app", async () => {
		const root = tmpRoot();
		try {
			createApp({
				name: "runner",
				description: "Run smoke test for the app loader",
				capabilities: ["read"],
				appsRoot: root,
				approved: true,
			});
			const logged: string[] = [];
			const res = await runApp(
				"runner",
				"hi-there",
				{
					log: (l) => logged.push(l),
					capabilities: ["read", "bash"],
				},
				root,
			);
			expect(res.ok).toBe(true);
			expect(res.output).toContain("hi-there");
			expect(logged.some((l) => l.includes("hi-there"))).toBe(true);
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});

	test("returns error when app not found", async () => {
		const root = tmpRoot();
		try {
			const res = await runApp("ghost", "", { log: () => {}, capabilities: [] }, root);
			expect(res.ok).toBe(false);
			expect(res.output).toContain("not found");
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});
});
