/**
 * SkillsView tests.
 *
 * The stateful SkillsView owns hooks (useState + useInput) which cannot run
 * outside an Ink render context, and the repo has no Ink test renderer. So,
 * like the other __tests__ here, we target the pure surfaces:
 *
 *   - loadSkillRows: reads the real SkillManager (repo .claude/skills etc.)
 *   - filterSkillRows / describeOrigin / computeWindowStart: pure helpers
 *   - SkillsBody: hook-free render, walked to plain text
 *
 * Plus the tab registration in useWorkspaceTabs.
 */
import { describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { Box, Text } from "ink";
import React from "react";
import { SkillManager } from "../../../../packages/skills/index";
import { SINGLETON_TYPES, TAB_ICONS, type TabType } from "../hooks/useWorkspaceTabs";
import {
	computeWindowStart,
	describeOrigin,
	EMPTY_STATE_TEXT,
	filterSkillRows,
	loadSkillRows,
	SkillsBody,
	type SkillRow,
	SkillsView,
} from "../screens/SkillsView";

/** Flatten a hook-free Ink element tree into the text it would print. */
function renderToText(node: React.ReactNode): string {
	if (node === null || node === undefined || typeof node === "boolean") return "";
	if (typeof node === "string" || typeof node === "number") return String(node);
	if (Array.isArray(node)) return node.map(renderToText).join("");
	if (!React.isValidElement(node)) return "";
	const el = node as React.ReactElement<{ children?: React.ReactNode }>;
	const type = el.type as unknown;
	if (type === Box || type === Text || typeof type !== "function") {
		return `${renderToText(el.props.children)}\n`;
	}
	const fn = type as (p: Record<string, unknown>) => React.ReactNode;
	return renderToText(fn(el.props as Record<string, unknown>));
}

function bodyProps(rows: SkillRow[], over: Partial<Parameters<typeof SkillsBody>[0]> = {}) {
	return {
		rows,
		filtered: rows,
		loaded: true,
		selectedIndex: 0,
		query: "",
		filtering: false,
		showHelp: false,
		windowSize: 14,
		...over,
	};
}

/** SKILL.md files the repo ships under .claude/skills, read from disk. */
function repoClaudeSkillFiles(): string[] {
	const root = path.join(process.cwd(), ".claude", "skills");
	if (!fs.existsSync(root)) return [];
	return fs
		.readdirSync(root, { withFileTypes: true })
		.filter((d) => d.isDirectory())
		.map((d) => path.join(root, d.name, "SKILL.md"))
		.filter((p) => fs.existsSync(p));
}

describe("skills tab registration", () => {
	test("skills is a registered singleton tab type with an icon and label", () => {
		const entry = TAB_ICONS.find((i) => i.type === "skills");
		expect(entry).toBeDefined();
		expect(entry?.label).toBe("Skills");
		expect(entry?.icon.length).toBeGreaterThan(0);
		expect(SINGLETON_TYPES).toContain("skills" as TabType);
	});

	test("SkillsView is exported and accepts its prop shape", () => {
		const el = React.createElement(SkillsView, {
			visible: false,
			onClose: () => {},
			onRun: () => {},
		});
		expect(el.type).toBe(SkillsView);
	});
});

describe("loadSkillRows", () => {
	test("returns the real loaded skills with existing file paths", async () => {
		const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "8gent-skills-test-"));
		try {
			const rows = await loadSkillRows(new SkillManager(tmp));
			expect(rows.length).toBeGreaterThan(0);
			for (const r of rows) {
				expect(fs.existsSync(r.filePath)).toBe(true);
				expect(r.name.length).toBeGreaterThan(0);
				expect(r.origin.length).toBeGreaterThan(0);
			}
			const paths = new Set(rows.map((r) => r.filePath));
			for (const p of repoClaudeSkillFiles()) expect(paths.has(p)).toBe(true);
			const names = rows.map((r) => r.name);
			expect(names).toEqual([...names].sort((a, b) => a.localeCompare(b)));
		} finally {
			fs.rmSync(tmp, { recursive: true, force: true });
		}
	});
});

describe("SkillsBody", () => {
	test("renders every loaded skill name and the selected skill's path", async () => {
		const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "8gent-skills-test-"));
		try {
			const rows = await loadSkillRows(new SkillManager(tmp));
			const text = renderToText(
				React.createElement(SkillsBody, bodyProps(rows, { windowSize: rows.length })),
			);
			for (const r of rows) expect(text).toContain(r.name);
			expect(text).toContain(`${rows.length} loaded`);
			expect(text).toContain(rows[0].origin);
			expect(text).toContain(path.basename(rows[0].filePath));
		} finally {
			fs.rmSync(tmp, { recursive: true, force: true });
		}
	});

	test("filter narrows the visible list to matching rows", async () => {
		const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "8gent-skills-test-"));
		try {
			const rows = await loadSkillRows(new SkillManager(tmp));
			const target = rows[rows.length - 1];
			const query = target.name.slice(0, Math.min(6, target.name.length));
			const filtered = filterSkillRows(rows, query);
			expect(filtered.length).toBeGreaterThan(0);
			expect(filtered.length).toBeLessThanOrEqual(rows.length);
			expect(filtered.map((r) => r.filePath)).toContain(target.filePath);
			for (const r of filtered) {
				const hay = `${r.name} ${r.description} ${r.origin}`.toLowerCase();
				expect(hay).toContain(query.toLowerCase());
			}
			const text = renderToText(
				React.createElement(
					SkillsBody,
					bodyProps(rows, { filtered, query, windowSize: rows.length }),
				),
			);
			expect(text).toContain(`${filtered.length} match "${query}"`);
			for (const r of rows) {
				if (!filtered.includes(r)) expect(text.includes(`\n ${r.name}\n`)).toBe(false);
			}
			expect(filterSkillRows(rows, "")).toEqual(rows);
			expect(filterSkillRows(rows, "zzz-no-such-skill-zzz")).toEqual([]);
		} finally {
			fs.rmSync(tmp, { recursive: true, force: true });
		}
	});

	test("empty state is the real sentence, and loading state is distinct", () => {
		const empty = renderToText(React.createElement(SkillsBody, bodyProps([])));
		expect(empty).toContain(EMPTY_STATE_TEXT);
		expect(empty).toContain("0 loaded");
		const loading = renderToText(
			React.createElement(SkillsBody, bodyProps([], { loaded: false })),
		);
		expect(loading).toContain("Loading skills");
		expect(loading).not.toContain(EMPTY_STATE_TEXT);
	});

	test("help overlay lists every key", () => {
		const text = renderToText(React.createElement(SkillsBody, bodyProps([], { showHelp: true })));
		for (const key of ["Up/Down", "/ Filter", "Enter Run", "Backspace", "Esc / q Close", "? Show"]) {
			expect(text).toContain(key);
		}
	});
});

describe("helpers", () => {
	test("describeOrigin names the root the file came from", () => {
		const home = "/Users/someone";
		expect(describeOrigin(`${home}/.8gent/skills/commit.md`, home)).toBe("~/.8gent/skills");
		expect(describeOrigin(`${home}/.8gent/learned-skills/x.md`, home)).toBe(
			"~/.8gent/learned-skills",
		);
		expect(describeOrigin(`${home}/repo/.claude/skills/Foo/SKILL.md`, home)).toBe("~/repo");
		expect(describeOrigin("/opt/pkg/skills/bar/SKILL.md", home)).toBe("/opt/pkg/skills/bar");
	});

	test("computeWindowStart keeps the selection on screen", () => {
		expect(computeWindowStart(5, 3, 14)).toBe(0);
		expect(computeWindowStart(100, 0, 10)).toBe(0);
		expect(computeWindowStart(100, 50, 10)).toBe(45);
		expect(computeWindowStart(100, 99, 10)).toBe(90);
	});
});
