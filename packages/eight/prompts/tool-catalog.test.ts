/**
 * Tool catalog segment tests (closes #1082 acceptance criterion:
 * "Unit test for shape of segment").
 *
 * Keeps the prompt honest: every registered category must surface in the
 * segment the model sees, and toggles must work without dropping content
 * essential to tool awareness.
 */

import { describe, expect, it } from "bun:test";
import { TOOL_CATEGORIES } from "../tool-registry.js";
import { REVIEW_FOCUS_NOTE, SLIDES_TO_VIDEO_NOTE, TOOL_CATALOG_SEGMENT, buildToolCatalogSegment } from "./system-prompt.js";

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

	it("fits in a reasonable token budget (< 4KB default, < 2.2KB concise; was 2KB until #3920 added the review note)", () => {
		expect(TOOL_CATALOG_SEGMENT.length).toBeLessThan(4096);
		const concise = buildToolCatalogSegment({ concise: true });
		expect(concise.length).toBeLessThan(2200);
	});

	it("tells the local model to keep scratch files inside the project (#3865)", () => {
		for (const text of [TOOL_CATALOG_SEGMENT, buildToolCatalogSegment({ concise: true })]) {
			expect(text).toContain(".tmp/");
			expect(text).toContain("never /tmp");
		}
	});
});

describe("slides-to-video join guidance (#3862)", () => {
	it("tells the model to cover every slide when joining", () => {
		expect(TOOL_CATALOG_SEGMENT).toContain("Slides to video");
		expect(TOOL_CATALOG_SEGMENT).toContain("segment count equals slide count");
		expect(TOOL_CATALOG_SEGMENT).toContain("trailing newline");
	});

	it("is present on the concise path the local TUI uses, within its budget", () => {
		const concise = buildToolCatalogSegment({ concise: true });
		expect(concise).toContain("segment count equals slide count");
		expect(concise).toContain("trailing newline");
		expect(concise.length).toBeLessThan(2200);
	});

	it("appears exactly once in each catalog variant", () => {
		for (const seg of [TOOL_CATALOG_SEGMENT, buildToolCatalogSegment({ concise: true })]) {
			expect(seg.split(SLIDES_TO_VIDEO_NOTE).length - 1).toBe(1);
		}
	});
});

describe("review focus guidance (#3920)", () => {
	it("is in both catalog variants exactly once, within the concise budget", () => {
		for (const seg of [TOOL_CATALOG_SEGMENT, buildToolCatalogSegment({ concise: true })]) {
			expect(seg.split(REVIEW_FOCUS_NOTE).length - 1).toBe(1);
		}
		expect(buildToolCatalogSegment({ concise: true }).length).toBeLessThan(2200);
		expect(REVIEW_FOCUS_NOTE).toContain("cite only the lines that must change");
	});
});
