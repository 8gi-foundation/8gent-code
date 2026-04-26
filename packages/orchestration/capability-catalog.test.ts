import { describe, it, expect } from "bun:test";
import { CapabilityCatalog } from "./capability-catalog.js";

describe("CapabilityCatalog", () => {
	it("resolve() finds capability by ID", () => {
		const catalog = new CapabilityCatalog();
		const cap = catalog.resolve("code:generate");
		expect(cap).toBeDefined();
		expect(cap!.id).toBe("code:generate");
		expect(cap!.category).toBe("code");
		expect(cap!.name).toBe("Generate Code");
	});

	it("resolve() finds capability by alias", () => {
		const catalog = new CapabilityCatalog();
		const cap = catalog.resolve("coding");
		expect(cap).toBeDefined();
		expect(cap!.id).toBe("code:generate");

		const cap2 = catalog.resolve("write-code");
		expect(cap2).toBeDefined();
		expect(cap2!.id).toBe("code:generate");
	});

	it("resolve() returns undefined for unknown capability", () => {
		const catalog = new CapabilityCatalog();
		const cap = catalog.resolve("teleportation");
		expect(cap).toBeUndefined();
	});

	it("validate() splits into valid and unknown", () => {
		const catalog = new CapabilityCatalog();
		const result = catalog.validate([
			"code:generate",
			"coding",
			"teleportation",
			"security:scan",
			"flying",
		]);
		expect(result.valid).toContain("code:generate");
		expect(result.valid).toContain("coding");
		expect(result.valid).toContain("security:scan");
		expect(result.valid).toHaveLength(3);
		expect(result.unknown).toContain("teleportation");
		expect(result.unknown).toContain("flying");
		expect(result.unknown).toHaveLength(2);
	});

	it("findBestMatch() ranks agents by coverage", () => {
		const catalog = new CapabilityCatalog();
		const agents = [
			{ id: "agent-1", capabilities: ["code:generate"] },
			{
				id: "agent-2",
				capabilities: ["code:generate", "code:review", "test:unit"],
			},
			{ id: "agent-3", capabilities: ["code:generate", "code:review"] },
		];
		const required = ["code:generate", "code:review", "test:unit"];
		const results = catalog.findBestMatch(required, agents);

		expect(results[0].agentId).toBe("agent-2");
		expect(results[0].score).toBe(3);
		expect(results[0].matched).toHaveLength(3);
		expect(results[0].missing).toHaveLength(0);

		expect(results[1].agentId).toBe("agent-3");
		expect(results[1].score).toBe(2);

		expect(results[2].agentId).toBe("agent-1");
		expect(results[2].score).toBe(1);
	});

	it("findBestMatch() reports missing capabilities", () => {
		const catalog = new CapabilityCatalog();
		const agents = [{ id: "agent-1", capabilities: ["code:generate"] }];
		const required = ["code:generate", "code:review", "test:unit"];
		const results = catalog.findBestMatch(required, agents);

		expect(results[0].missing).toContain("code:review");
		expect(results[0].missing).toContain("test:unit");
		expect(results[0].missing).toHaveLength(2);
	});

	it("findBestMatch() resolves aliases in agent capabilities", () => {
		const catalog = new CapabilityCatalog();
		const agents = [
			{ id: "agent-1", capabilities: ["coding", "review", "unit-test"] },
			{ id: "agent-2", capabilities: ["code:generate"] },
		];
		const required = ["code:generate", "code:review", "test:unit"];
		const results = catalog.findBestMatch(required, agents);

		// agent-1 uses aliases but should still match all 3
		expect(results[0].agentId).toBe("agent-1");
		expect(results[0].score).toBe(3);
		expect(results[0].matched).toHaveLength(3);
	});

	it("register() adds a new custom capability", () => {
		const catalog = new CapabilityCatalog();
		catalog.register({
			id: "custom:magic",
			category: "custom",
			name: "Magic Trick",
			description: "Performs magic",
			aliases: ["magic", "wizardry"],
		});

		const cap = catalog.resolve("custom:magic");
		expect(cap).toBeDefined();
		expect(cap!.name).toBe("Magic Trick");

		const byAlias = catalog.resolve("wizardry");
		expect(byAlias).toBeDefined();
		expect(byAlias!.id).toBe("custom:magic");
	});

	it("built-in capabilities exist for code, test, infra, data, doc, security categories", () => {
		const catalog = new CapabilityCatalog();
		const categories = ["code", "test", "infra", "data", "doc", "security"];

		for (const category of categories) {
			const caps = catalog.listByCategory(category);
			expect(caps.length).toBeGreaterThan(0);
		}

		// Verify specific counts
		expect(catalog.listByCategory("code").length).toBe(4); // generate, review, refactor, debug
		expect(catalog.listByCategory("test").length).toBe(3); // unit, integration, e2e
		expect(catalog.listByCategory("infra").length).toBe(3); // deploy, monitor, config
		expect(catalog.listByCategory("data").length).toBe(3); // query, transform, visualize
		expect(catalog.listByCategory("doc").length).toBe(2); // write, review
		expect(catalog.listByCategory("security").length).toBe(2); // scan, audit
	});
});
