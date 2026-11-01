/**
 * Read-only scan of what an owner built in other tools (#5037, slice 1).
 *
 * Lists files by name and counts them per tool and kind. It never opens a file: the only
 * filesystem calls it can make are the ones in FsLike, and none of them read content, so a
 * credentials file cannot be read even by mistake. Anything that may hold a token is listed
 * under `skipped` with the reason, and anything that is not mapped yet is listed by name under
 * `unmapped`, so nothing is silently left behind.
 */

import * as fs from "node:fs";
import * as path from "node:path";

export type ToolId = "claude" | "agents" | "codex" | "cursor" | "pi" | "hermes";
export type ImportKind = "instructions" | "skill" | "command" | "memory" | "rule";

/** The filesystem calls the scanner may use. None of them reads file content. */
export interface FsLike {
	existsSync(p: string): boolean;
	readdirSync(p: string): string[];
	statSync(p: string): { isDirectory(): boolean; isFile(): boolean };
}

export interface FoundItem {
	tool: ToolId;
	kind: ImportKind;
	/** Skill folder name, file base name, or "<project>/<file>" for memory. */
	name: string;
	/** Absolute path of the file to import. */
	path: string;
}

export interface SkippedItem {
	tool: ToolId;
	path: string;
	reason: string;
}

export interface ToolScan {
	tool: ToolId;
	label: string;
	/** Display root, e.g. ~/.claude */
	root: string;
	items: FoundItem[];
	counts: Record<ImportKind, number>;
	skipped: SkippedItem[];
	/** Top-level entries found but not mapped in this slice, by name. */
	unmapped: string[];
}

export interface ScanResult {
	home: string;
	tools: ToolScan[];
	totalItems: number;
	totalSkipped: number;
}

export interface ScanOptions {
	home: string;
	fs?: FsLike;
}

const LABELS: Record<ToolId, string> = {
	claude: "Claude Code",
	agents: "Shared skills",
	codex: "Codex",
	cursor: "Cursor",
	pi: "pi",
	hermes: "Hermes",
};

/** Import order and dedupe priority: earlier tools win a same-named skill. */
export const TOOL_ORDER: ToolId[] = ["claude", "agents", "codex", "pi", "hermes", "cursor"];

/** Names that may hold tokens or keys. Never opened, listed as skipped. */
const SECRET_NAME =
	/^(\.env(\..*)?|.*\.env|auth(\..*)?|.*credential.*|.*token.*|.*secret.*|.*\.(pem|key|p12)|settings(\.local)?\.json|config\.(toml|json)|mcp\.json|hooks\.json)$/i;

function emptyCounts(): Record<ImportKind, number> {
	return { instructions: 0, skill: 0, command: 0, memory: 0, rule: 0 };
}

interface Ctx {
	fs: FsLike;
}

function safe<T>(fn: () => T, fallback: T): T {
	try {
		return fn();
	} catch {
		return fallback;
	}
}

function isDir(c: Ctx, p: string): boolean {
	return safe(() => c.fs.statSync(p).isDirectory(), false);
}
function isFile(c: Ctx, p: string): boolean {
	return safe(() => c.fs.statSync(p).isFile(), false);
}
function list(c: Ctx, p: string): string[] {
	return safe(() => c.fs.readdirSync(p), [] as string[]).sort();
}

function skillItems(c: Ctx, tool: ToolId, dir: string): FoundItem[] {
	const out: FoundItem[] = [];
	for (const name of list(c, dir)) {
		const md = path.join(dir, name, "SKILL.md");
		if (isDir(c, path.join(dir, name)) && isFile(c, md))
			out.push({ tool, kind: "skill", name, path: md });
	}
	return out;
}

/** Markdown files under dir, up to `depth` folders deep. */
function mdItems(
	c: Ctx,
	tool: ToolId,
	kind: ImportKind,
	dir: string,
	depth: number,
	exts = [".md"],
): FoundItem[] {
	const out: FoundItem[] = [];
	const walk = (d: string, rel: string, left: number) => {
		for (const name of list(c, d)) {
			const full = path.join(d, name);
			if (SECRET_NAME.test(name)) continue;
			if (isDir(c, full)) {
				if (left > 0) walk(full, rel ? `${rel}/${name}` : name, left - 1);
			} else if (isFile(c, full) && exts.some((e) => name.toLowerCase().endsWith(e))) {
				const base = name.replace(/\.[^.]+$/, "");
				out.push({ tool, kind, name: rel ? `${rel}/${base}` : base, path: full });
			}
		}
	};
	walk(dir, "", depth);
	return out;
}

function fileItem(c: Ctx, tool: ToolId, kind: ImportKind, file: string, name: string): FoundItem[] {
	return isFile(c, file) ? [{ tool, kind, name, path: file }] : [];
}

function memoryItems(c: Ctx, tool: ToolId, projectsDir: string): FoundItem[] {
	const out: FoundItem[] = [];
	for (const proj of list(c, projectsDir)) {
		const mem = path.join(projectsDir, proj, "memory");
		for (const f of list(c, mem)) {
			const full = path.join(mem, f);
			if (f.toLowerCase().endsWith(".md") && !SECRET_NAME.test(f) && isFile(c, full))
				out.push({ tool, kind: "memory", name: `${proj}/${f.replace(/\.md$/i, "")}`, path: full });
		}
	}
	return out;
}

interface ToolSpec {
	tool: ToolId;
	/** Dir relative to home. */
	dir: string;
	/** Top-level names that this slice maps (so they are not reported as unmapped). */
	mapped: string[];
	collect(c: Ctx, root: string): FoundItem[];
}

const SPECS: ToolSpec[] = [
	{
		tool: "claude",
		dir: ".claude",
		mapped: ["CLAUDE.md", "skills", "commands", "projects"],
		collect: (c, r) => [
			...fileItem(c, "claude", "instructions", path.join(r, "CLAUDE.md"), "CLAUDE"),
			...skillItems(c, "claude", path.join(r, "skills")),
			...mdItems(c, "claude", "command", path.join(r, "commands"), 2),
			...memoryItems(c, "claude", path.join(r, "projects")),
		],
	},
	{
		tool: "agents",
		dir: ".agents",
		mapped: ["skills"],
		collect: (c, r) => skillItems(c, "agents", path.join(r, "skills")),
	},
	{
		tool: "codex",
		dir: ".codex",
		mapped: ["AGENTS.md", "prompts"],
		collect: (c, r) => [
			...fileItem(c, "codex", "instructions", path.join(r, "AGENTS.md"), "AGENTS"),
			...mdItems(c, "codex", "command", path.join(r, "prompts"), 1),
		],
	},
	{
		tool: "cursor",
		dir: ".cursor",
		mapped: ["rules"],
		collect: (c, r) => mdItems(c, "cursor", "rule", path.join(r, "rules"), 2, [".md", ".mdc"]),
	},
	{
		// pi keeps its personal layer under ~/.pi/agent (not documented in this repo; from pi's own layout).
		tool: "pi",
		dir: path.join(".pi", "agent"),
		mapped: ["AGENTS.md", "skills", "prompts"],
		collect: (c, r) => [
			...fileItem(c, "pi", "instructions", path.join(r, "AGENTS.md"), "AGENTS"),
			...skillItems(c, "pi", path.join(r, "skills")),
			...mdItems(c, "pi", "command", path.join(r, "prompts"), 1),
		],
	},
	{
		// Hermes keeps its personal layer under ~/.hermes (not documented in this repo; from Hermes's own layout).
		tool: "hermes",
		dir: ".hermes",
		mapped: ["SOUL.md", "memories", "skills"],
		collect: (c, r) => [
			...fileItem(c, "hermes", "instructions", path.join(r, "SOUL.md"), "SOUL"),
			...mdItems(c, "hermes", "memory", path.join(r, "memories"), 1),
			...skillItems(c, "hermes", path.join(r, "skills")),
		],
	},
];

/** Single files in the home folder that hold tokens; listed as skipped, never opened. */
const HOME_SECRET_FILES: { tool: ToolId; file: string }[] = [
	{ tool: "claude", file: ".claude.json" },
];

export function scanOtherTools(opts: ScanOptions): ScanResult {
	const c: Ctx = { fs: opts.fs ?? (fs as unknown as FsLike) };
	const home = opts.home;
	const tools: ToolScan[] = [];

	for (const spec of SPECS) {
		const root = path.join(home, spec.dir);
		if (!isDir(c, root)) continue;
		const items = spec.collect(c, root);
		const skipped: SkippedItem[] = [];
		const unmapped: string[] = [];
		for (const name of list(c, root)) {
			if (SECRET_NAME.test(name)) {
				skipped.push({
					tool: spec.tool,
					path: path.join(root, name),
					reason: "may hold a token or key; never opened",
				});
			} else if (!spec.mapped.includes(name) && !name.startsWith(".DS_Store")) {
				unmapped.push(name);
			}
		}
		for (const h of HOME_SECRET_FILES) {
			const f = path.join(home, h.file);
			if (h.tool === spec.tool && safe(() => c.fs.existsSync(f), false))
				skipped.push({ tool: spec.tool, path: f, reason: "may hold a token or key; never opened" });
		}
		const counts = emptyCounts();
		for (const i of items) counts[i.kind]++;
		if (items.length === 0 && skipped.length === 0 && unmapped.length === 0) continue;
		tools.push({
			tool: spec.tool,
			label: LABELS[spec.tool],
			root: `~/${spec.dir}`,
			items,
			counts,
			skipped,
			unmapped,
		});
	}

	return {
		home,
		tools,
		totalItems: tools.reduce((n, t) => n + t.items.length, 0),
		totalSkipped: tools.reduce((n, t) => n + t.skipped.length, 0),
	};
}

const KIND_WORDS: Record<ImportKind, [string, string]> = {
	skill: ["skill", "skills"],
	instructions: ["instruction file", "instruction files"],
	rule: ["rule", "rules"],
	command: ["command", "commands"],
	memory: ["memory note", "memory notes"],
};

/** Plain-language summary for the one y/N question. Names counts and skipped files, never contents. */
export function summarizeScan(scan: ScanResult): string {
	const lines: string[] = [];
	for (const t of scan.tools) {
		const parts = (Object.keys(KIND_WORDS) as ImportKind[])
			.filter((k) => t.counts[k] > 0)
			.map((k) => `${t.counts[k]} ${KIND_WORDS[k][t.counts[k] === 1 ? 0 : 1]}`);
		if (parts.length > 0) lines.push(`  ${t.label} (${t.root}): ${parts.join(", ")}`);
	}
	const skipped = scan.tools.flatMap((t) => t.skipped.map((s) => path.basename(s.path)));
	if (skipped.length > 0)
		lines.push(`  Skipped, never opened (may hold keys): ${[...new Set(skipped)].join(", ")}`);
	const unmapped = scan.tools.flatMap((t) => t.unmapped.map((u) => `${t.root}/${u}`));
	if (unmapped.length > 0)
		lines.push(
			`  Found but not brought home yet: ${unmapped.slice(0, 12).join(", ")}${unmapped.length > 12 ? `, and ${unmapped.length - 12} more` : ""}`,
		);
	return lines.join("\n");
}
