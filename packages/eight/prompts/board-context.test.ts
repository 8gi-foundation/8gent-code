/**
 * Board context segment tests.
 *
 * Proves the UNIVERSAL injection: the standing board briefing on disk is read
 * into the `## BOARD CONTEXT` block and surfaces in the user-context segment +
 * the composed prompts (so the doer, the officers, and forked children all
 * inherit it). Also proves it omits cleanly when the file is absent/empty, caps
 * a long file, and stays a pure read (no network).
 */

import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "bun:test";
import {
	BOARD_CONTEXT_CAP,
	USER_CONTEXT_SEGMENT,
	buildBoardContextSegment,
	buildTieredSystemPrompt,
	getFullSystemPrompt,
} from "./system-prompt.js";

const tmp = mkdtempSync(join(tmpdir(), "board-ctx-"));
afterAll(() => rmSync(tmp, { recursive: true, force: true }));

function writeBriefing(name: string, content: string): string {
	const path = join(tmp, name);
	writeFileSync(path, content, "utf-8");
	return path;
}

describe("buildBoardContextSegment", () => {
	it("emits a labelled block with the file's content and the query instruction", () => {
		const path = writeBriefing(
			"good.md",
			"# 8GI Board Context\n\n## Mission\nDemocratize intelligence.",
		);
		const seg = buildBoardContextSegment(path);
		expect(seg).toContain("## BOARD CONTEXT");
		expect(seg).toContain("Democratize intelligence.");
		// The tool-capability / query-don't-guess steer is the whole point.
		expect(seg.toLowerCase()).toContain("query");
		expect(seg.toLowerCase()).toContain("tool-capable");
		expect(seg.toLowerCase()).toContain("guess");
	});

	it("omits cleanly (empty string) when the file is absent", () => {
		const seg = buildBoardContextSegment(join(tmp, "does-not-exist.md"));
		expect(seg).toBe("");
	});

	it("omits cleanly when the file is empty / whitespace", () => {
		const path = writeBriefing("empty.md", "   \n  \n");
		expect(buildBoardContextSegment(path)).toBe("");
	});

	it("caps an over-long briefing and marks it truncated", () => {
		const big = `${"x".repeat(BOARD_CONTEXT_CAP * 2)}`;
		const path = writeBriefing("big.md", big);
		const seg = buildBoardContextSegment(path);
		expect(seg).toContain("truncated");
		// Block is bounded: cap + a small header/footer, never the full 2x payload.
		expect(seg.length).toBeLessThan(BOARD_CONTEXT_CAP + 600);
	});

	it("never throws and returns a string for any input path", () => {
		expect(typeof buildBoardContextSegment("/nope/nope/nope.md")).toBe("string");
	});
});

describe("USER_CONTEXT_SEGMENT appends the board briefing", () => {
	it("includes BOARD CONTEXT when the real file exists", () => {
		// The real path is read here; on James's machine the briefing exists, so we
		// assert presence-or-absence consistently against the live file via the
		// builder rather than asserting a hardcoded path.
		const live = buildBoardContextSegment();
		const seg = USER_CONTEXT_SEGMENT({ name: "James" });
		expect(seg).toContain("## USER CONTEXT");
		expect(seg).toContain("James");
		if (live) {
			expect(seg).toContain("## BOARD CONTEXT");
		} else {
			expect(seg).not.toContain("## BOARD CONTEXT");
		}
	});

	it("still returns the board block even with no user fields (universal reach)", () => {
		const live = buildBoardContextSegment();
		const seg = USER_CONTEXT_SEGMENT({});
		if (live) {
			expect(seg).toContain("## BOARD CONTEXT");
		} else {
			expect(seg).toBe("");
		}
	});
});

describe("composed prompts inherit the board briefing", () => {
	it("getFullSystemPrompt includes BOARD CONTEXT iff the file exists", () => {
		const live = buildBoardContextSegment();
		const prompt = getFullSystemPrompt();
		if (live) expect(prompt).toContain("## BOARD CONTEXT");
		else expect(prompt).not.toContain("## BOARD CONTEXT");
	});

	it("buildTieredSystemPrompt includes BOARD CONTEXT iff the file exists", () => {
		const live = buildBoardContextSegment();
		const prompt = buildTieredSystemPrompt("collaborator");
		if (live) expect(prompt).toContain("## BOARD CONTEXT");
		else expect(prompt).not.toContain("## BOARD CONTEXT");
	});
});
