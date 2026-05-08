/**
 * Tests for ArtifactRegistryStore (issue #2420).
 *
 * The registry is the load-bearing primitive: every artifact that goes in
 * must come back out across compressions, so we test extraction, ordering,
 * the verbatim render output, and JSON round-trips.
 */

import { describe, expect, it } from "bun:test";
import { ArtifactRegistryStore, extractFilesFromText } from "../artifact-registry";

describe("extractFilesFromText", () => {
	it("pulls paths out of read_file/write_file tool args", () => {
		const text = `{"name":"read_file","args":{"file_path":"packages/daemon/context/types.ts"}}`;
		const found = extractFilesFromText(text);
		expect(found).toContain("packages/daemon/context/types.ts");
	});

	it("picks up bare relative paths", () => {
		const text = "I just edited apps/tui/src/index.tsx and ran the test.";
		const found = extractFilesFromText(text);
		expect(found).toContain("apps/tui/src/index.tsx");
	});

	it("picks up shell-style cat invocations", () => {
		const text = "Run `cat README.md` to see the project layout.";
		const found = extractFilesFromText(text);
		expect(found).toContain("README.md");
	});

	it("skips runaway matches", () => {
		const text = `path looks like ${"x/".repeat(400)}foo.ts`;
		const found = extractFilesFromText(text);
		// Wildly long paths are filtered out (length > 500)
		for (const f of found) expect(f.length).toBeLessThanOrEqual(500);
	});
});

describe("ArtifactRegistryStore", () => {
	it("tracks a file once even when ingested twice", () => {
		const store = new ArtifactRegistryStore();
		store.ingestMessage({
			role: "assistant",
			content: "edited packages/daemon/agent-pool.ts",
		});
		store.ingestMessage({
			role: "user",
			content: "now run the tests on packages/daemon/agent-pool.ts",
		});
		expect(store.stats().files).toBe(1);
	});

	it("records entities and decisions explicitly", () => {
		const store = new ArtifactRegistryStore();
		store.trackEntity("AgentPool", "class", "manages session lifecycle");
		store.trackDecision("use openai-compatible providers", "single SDK across local + cloud");
		const stats = store.stats();
		expect(stats.entities).toBe(1);
		expect(stats.decisions).toBe(1);
	});

	it("rejects empty paths/names silently", () => {
		const store = new ArtifactRegistryStore();
		store.trackFile("", "modified");
		store.trackEntity("", "type", "desc");
		store.trackDecision("", "rationale");
		const stats = store.stats();
		expect(stats.files).toBe(0);
		expect(stats.entities).toBe(0);
		expect(stats.decisions).toBe(0);
	});

	it("renders a stable, sorted markdown block", () => {
		const store = new ArtifactRegistryStore();
		store.trackFile("z/last.ts", "modified");
		store.trackFile("a/first.ts", "read");
		store.trackEntity("Zara", "officer", "8MO");
		store.trackEntity("Adam", "officer", "8GO");
		store.trackDecision("ship v1", "deadline");
		const rendered = store.render();

		expect(rendered).toContain("## Artifact Registry (preserve verbatim)");
		expect(rendered.indexOf("a/first.ts")).toBeLessThan(rendered.indexOf("z/last.ts"));
		expect(rendered.indexOf("Adam")).toBeLessThan(rendered.indexOf("Zara"));
		expect(rendered).toContain("ship v1");
	});

	it("round-trips through JSON", () => {
		const store = new ArtifactRegistryStore();
		store.trackFile("foo.ts", "modified");
		store.trackEntity("AgentPool", "class", "manages sessions");
		store.trackDecision("use Bun", "speed");

		const snapshot = store.toJSON();
		const restored = ArtifactRegistryStore.fromJSON(snapshot);
		const stats = restored.stats();
		expect(stats.files).toBe(1);
		expect(stats.entities).toBe(1);
		expect(stats.decisions).toBe(1);

		const rendered = restored.render();
		expect(rendered).toContain("foo.ts");
		expect(rendered).toContain("AgentPool");
		expect(rendered).toContain("use Bun");
	});

	it("ingestMessages walks a full history", () => {
		const store = new ArtifactRegistryStore();
		store.ingestMessages([
			{ role: "user", content: "look at packages/daemon/index.ts" },
			{ role: "assistant", content: "reading apps/tui/src/index.tsx" },
			{ role: "tool", content: '{"path":"README.md"}' },
		]);
		expect(store.stats().files).toBeGreaterThanOrEqual(3);
	});
});
