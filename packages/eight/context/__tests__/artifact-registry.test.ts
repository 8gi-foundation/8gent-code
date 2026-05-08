import { describe, expect, it } from "bun:test";
import { ArtifactRegistry } from "../artifact-registry";

describe("ArtifactRegistry", () => {
	it("stores and retrieves artifacts by kind+key", () => {
		const r = new ArtifactRegistry();
		r.add("file", "src/foo.ts", "(read)");
		expect(r.has("file", "src/foo.ts")).toBe(true);
		expect(r.get("file", "src/foo.ts")?.value).toBe("(read)");
	});

	it("increments hits on repeat add and updates value", () => {
		const r = new ArtifactRegistry();
		r.add("file", "a.ts", "v1");
		r.add("file", "a.ts", "v2");
		const a = r.get("file", "a.ts");
		expect(a?.hits).toBe(2);
		expect(a?.value).toBe("v2");
	});

	it("evicts oldest when over per-kind cap", () => {
		const r = new ArtifactRegistry({ caps: { file: 3 } });
		r.add("file", "a.ts", "");
		r.add("file", "b.ts", "");
		r.add("file", "c.ts", "");
		r.add("file", "d.ts", "");
		expect(r.size("file")).toBe(3);
		expect(r.has("file", "a.ts")).toBe(false);
		expect(r.has("file", "d.ts")).toBe(true);
	});

	it("touching an existing entry refreshes its LRU position", () => {
		const r = new ArtifactRegistry({ caps: { file: 3 } });
		r.add("file", "a.ts", "");
		r.add("file", "b.ts", "");
		r.add("file", "c.ts", "");
		r.add("file", "a.ts", ""); // touch a — should now be most-recent
		r.add("file", "d.ts", "");
		// Eviction should have dropped b.ts (now oldest), kept a.
		expect(r.has("file", "a.ts")).toBe(true);
		expect(r.has("file", "b.ts")).toBe(false);
	});

	it("renders a non-empty block when artifacts exist", () => {
		const r = new ArtifactRegistry();
		r.add("file", "src/foo.ts", "");
		r.add("decision", "d1", "use bun for tests");
		const out = r.render();
		expect(out).toContain("Artifact Registry");
		expect(out).toContain("src/foo.ts");
		expect(out).toContain("use bun");
	});

	it("renders empty string when registry is empty", () => {
		expect(new ArtifactRegistry().render()).toBe("");
	});

	it("truncates rendered block to maxRenderChars", () => {
		const r = new ArtifactRegistry({ maxRenderChars: 200 });
		for (let i = 0; i < 50; i++) r.add("file", `f${i}.ts`, "x".repeat(50));
		const out = r.render();
		expect(out.length).toBeLessThanOrEqual(200);
		expect(out).toContain("registry truncated");
	});

	it("snapshot reports per-kind counts", () => {
		const r = new ArtifactRegistry();
		r.add("file", "a.ts", "");
		r.add("file", "b.ts", "");
		r.add("decision", "d1", "");
		const snap = r.snapshot();
		expect(snap.total).toBe(3);
		expect(snap.byKind.file).toBe(2);
		expect(snap.byKind.decision).toBe(1);
	});
});
