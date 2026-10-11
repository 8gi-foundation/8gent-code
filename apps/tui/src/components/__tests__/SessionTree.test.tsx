/**
 * SessionTree: flattening a real SessionStore tree into rows, and the
 * rendered view.
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { renderToString } from "ink";
import React from "react";
import { SessionStore } from "../../../../../packages/eight/session-store";
import { SessionTreeView, filterRows, flattenTree } from "../SessionTree";

let dir: string;
beforeAll(() => {
	dir = fs.mkdtempSync(path.join(os.tmpdir(), "session-tree-ui-"));
});
afterAll(() => fs.rmSync(dir, { recursive: true, force: true }));

/** q -> a1 -> q2 ; q -> a2 (current) */
function forked() {
	const s = SessionStore.create({ cwd: dir }, dir);
	const q = s.append({ role: "user", content: "fix the login bug" });
	const a1 = s.append({ role: "assistant", content: "patched auth.ts" });
	const q2 = s.append({ role: "user", content: "now the tests" });
	s.branch(q);
	const a2 = s.append({ role: "assistant", content: "rewrote   session\nhandling" });
	return { s, q, a1, q2, a2 };
}

describe("flattenTree", () => {
	test("a straight chain stays at one indent; a fork indents its branches", () => {
		const { s, q, a1, q2, a2 } = forked();
		const rows = flattenTree(s.tree(), s.leafId);
		expect(rows.map((r) => [r.id, r.depth, r.branchStart])).toEqual([
			[q, 0, false],
			[a1, 1, true],
			[q2, 1, false],
			[a2, 1, true],
		]);
	});

	test("marks the current path and the leaf", () => {
		const { s, q, a1, a2 } = forked();
		const rows = flattenTree(s.tree(), s.leafId);
		const by = Object.fromEntries(rows.map((r) => [r.id, r]));
		expect(by[q].onPath).toBe(true);
		expect(by[a2]).toMatchObject({
			onPath: true,
			isLeaf: true,
			preview: "rewrote session handling",
		});
		expect(by[a1].onPath).toBe(false);
	});

	test("compactions and branch summaries get their own rows", () => {
		const { s, q } = forked();
		s.compact("summary of the fix", { keepLast: 1 });
		s.branch(q, { summary: "abandoned the rewrite" });
		const rows = flattenTree(s.tree(), s.leafId);
		expect(rows.find((r) => r.kind === "compaction")?.preview).toBe("summary of the fix");
		expect(rows.find((r) => r.kind === "branch_summary")).toMatchObject({
			preview: "abandoned the rewrite",
			isLeaf: true,
		});
	});

	test("user-only filter keeps user messages and markers", () => {
		const { s } = forked();
		s.compact("sum");
		const rows = filterRows(flattenTree(s.tree(), s.leafId), true);
		expect(rows.map((r) => (r.kind === "message" ? r.role : r.kind))).toEqual([
			"user",
			"user",
			"compaction",
		]);
	});

	test("a 5000-entry chain flattens without overflowing the stack", () => {
		const s = SessionStore.create({ cwd: dir }, dir);
		for (let i = 0; i < 5000; i++)
			s.append({ role: i % 2 ? "assistant" : "user", content: `m${i}` });
		const rows = flattenTree(s.tree(), s.leafId);
		expect(rows).toHaveLength(5000);
		expect(rows.every((r) => r.depth === 0 && r.onPath)).toBe(true);
	});
});

describe("SessionTreeView", () => {
	test("renders roles, previews, and path markers", () => {
		const { s } = forked();
		const rows = flattenTree(s.tree(), s.leafId);
		const out = renderToString(<SessionTreeView rows={rows} active={3} userOnly={false} />, {
			columns: 100,
		});
		expect(out).toContain("SESSION TREE");
		expect(out).toContain("fix the login bug");
		expect(out).toContain("◆ assistant");
		expect(out).toContain("○ assistant");
		expect(out).toContain("├");
		expect(out).toContain("continue here");
	});
});
