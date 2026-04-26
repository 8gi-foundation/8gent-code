/**
 * Tests for agent-mesh: the MeshAgentType union is vendor-neutral and
 * normalizeMeshAgentType() migrates legacy persisted labels at read time.
 * See issue #1819.
 */

import { test, expect, describe } from "bun:test";

import { normalizeMeshAgentType, type MeshAgentType } from "./agent-mesh";

describe("normalizeMeshAgentType", () => {
	test("maps legacy vendor-named labels to generic ones", () => {
		expect(normalizeMeshAgentType("claude-code")).toBe("host-cli-primary");
		expect(normalizeMeshAgentType("codex")).toBe("host-cli-secondary");
		expect(normalizeMeshAgentType("opencode")).toBe("host-cli-tertiary");
		expect(normalizeMeshAgentType("cursor")).toBe("host-cli-quaternary");
	});

	test("passes current generic labels through unchanged", () => {
		const current: MeshAgentType[] = [
			"host-cli-primary",
			"host-cli-secondary",
			"host-cli-tertiary",
			"host-cli-quaternary",
			"eight",
			"lil-eight",
			"custom",
		];
		for (const label of current) {
			expect(normalizeMeshAgentType(label)).toBe(label);
		}
	});

	test("unknown labels fall back to 'custom'", () => {
		expect(normalizeMeshAgentType("hermes")).toBe("custom");
		expect(normalizeMeshAgentType("future-tool")).toBe("custom");
		expect(normalizeMeshAgentType("")).toBe("custom");
	});
});
