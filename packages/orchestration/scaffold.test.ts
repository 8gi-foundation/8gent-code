import { describe, expect, test } from "bun:test";
import { getScaffold } from "./scaffold.js";

const EM_DASH = "—";

describe("getScaffold(next-app)", () => {
	const scaffold = getScaffold("next-app");

	test("declares the next-app project type", () => {
		expect(scaffold.projectType).toBe("next-app");
	});

	test("ships package.json and app/layout.tsx", () => {
		const paths = scaffold.files.map((f) => f.path);
		expect(paths).toContain("package.json");
		expect(paths).toContain("app/layout.tsx");
	});

	test("does NOT ship app/page.tsx (the model builds it)", () => {
		const paths = scaffold.files.map((f) => f.path);
		expect(paths).not.toContain("app/page.tsx");
	});

	test("structureNote is non-empty and mentions components/", () => {
		expect(scaffold.structureNote.length).toBeGreaterThan(0);
		expect(scaffold.structureNote).toContain("components/");
	});

	test("designTokens has an accent", () => {
		expect(scaffold.designTokens).toBeDefined();
		expect(scaffold.designTokens?.accent).toBeTruthy();
	});

	test("package.json pins next 14.2.5 and framer-motion", () => {
		const pkg = scaffold.files.find((f) => f.path === "package.json");
		expect(pkg).toBeDefined();
		const parsed = JSON.parse(pkg!.content);
		expect(parsed.dependencies.next).toBe("14.2.5");
		expect(parsed.dependencies["framer-motion"]).toBeTruthy();
	});

	test("tsconfig.json defines the @/* path alias", () => {
		const ts = scaffold.files.find((f) => f.path === "tsconfig.json");
		expect(ts).toBeDefined();
		expect(ts!.content).toContain("@/*");
	});
});

describe("brand safety across all scaffolds", () => {
	const types = ["next-app", "static-site", "totally-unknown"];

	test("no scaffold file content contains an em dash", () => {
		for (const type of types) {
			for (const file of getScaffold(type).files) {
				expect(file.content.includes(EM_DASH)).toBe(false);
			}
		}
	});

	test("no scaffold file content names a banned purple/pink color token", () => {
		const banned = ["purple", "violet", "magenta", "fuchsia", "#ff00ff"];
		for (const type of types) {
			for (const file of getScaffold(type).files) {
				const lower = file.content.toLowerCase();
				for (const word of banned) {
					expect(lower.includes(word)).toBe(false);
				}
			}
		}
	});
});

describe("getScaffold(unknown)", () => {
	test("returns a Scaffold without throwing and carries a structureNote", () => {
		const scaffold = getScaffold("totally-unknown");
		expect(scaffold.projectType).toBe("totally-unknown");
		expect(Array.isArray(scaffold.files)).toBe(true);
		expect(scaffold.structureNote.length).toBeGreaterThan(0);
	});
});

describe("getScaffold(static-site)", () => {
	test("ships an index.html shell and a structureNote", () => {
		const scaffold = getScaffold("static-site");
		const paths = scaffold.files.map((f) => f.path);
		expect(paths).toContain("index.html");
		expect(scaffold.structureNote.length).toBeGreaterThan(0);
	});
});
