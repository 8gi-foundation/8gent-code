/**
 * Tool catalog segment tests (closes #1082 acceptance criterion:
 * "Unit test for shape of segment").
 *
 * Keeps the prompt honest: every registered category must surface in the
 * segment the model sees, and toggles must work without dropping content
 * essential to tool awareness.
 */

import { describe, it, expect } from "bun:test";
import {
	buildToolCatalogSegment,
	TOOL_CATALOG_SEGMENT,
} from "./system-prompt.js";
import { TOOL_CATEGORIES } from "../tool-registry.js";

describe("buildToolCatalogSegment", () => {
	it("has a clear header", () => {
		expect(TOOL_CATALOG_SEGMENT).toContain("## TOOLS YOU HAVE");
	});

	it("names every registered category in the default segment", () => {
		for (const category of Object.keys(TOOL_CATEGORIES)) {
			expect(TOOL_CATALOG_SEGMENT).toContain(category);
		}
	});

	it("names every registered tool in the default segment", () => {
		for (const tools of Object.values(TOOL_CATEGORIES)) {
			for (const tool of tools) {
				expect(TOOL_CATALOG_SEGMENT).toContain(tool);
			}
		}
	});

	it("tells the model web_search exists and is callable", () => {
		expect(TOOL_CATALOG_SEGMENT).toContain("web_search");
		// The model should never claim no internet access.
		expect(TOOL_CATALOG_SEGMENT.toLowerCase()).toContain("web");
	});

	it("concise mode drops rich descriptions but keeps all tool names", () => {
		const concise = buildToolCatalogSegment({ concise: true });
		// Still mentions every tool
		for (const tools of Object.values(TOOL_CATEGORIES)) {
			for (const tool of tools) {
				expect(concise).toContain(tool);
			}
		}
		// Concise version is meaningfully shorter than the default
		expect(concise.length).toBeLessThan(TOOL_CATALOG_SEGMENT.length);
	});

	it("deferred mode mentions discover_tools", () => {
		const deferred = buildToolCatalogSegment({ deferred: true });
		expect(deferred).toContain("discover_tools");
	});

	it("non-deferred mode does NOT tell the model to call discover_tools", () => {
		expect(TOOL_CATALOG_SEGMENT).not.toContain("discover_tools");
	});

	it("fits in a reasonable token budget (< 4KB default, < 2KB concise)", () => {
		expect(TOOL_CATALOG_SEGMENT.length).toBeLessThan(4096);
		const concise = buildToolCatalogSegment({ concise: true });
		expect(concise.length).toBeLessThan(2048);
	});
});
