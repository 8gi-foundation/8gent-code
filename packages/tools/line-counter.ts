/**
 * Line counter tool - counts code/blank/comment lines per file,
 * detects language from extension, aggregates stats by directory.
 * Supports TS, JS, Python, Go, Rust comment styles.
 */

import { readFileSync, readdirSync, statSync } from "node:fs";
import { extname, join } from "node:path";

export interface LineStats {
	code: number;
	blank: number;
	comment: number;
	total: number;
	language: string;
	filePath: string;
}

export interface ProjectStats {
	byLanguage: Record<string, Omit<LineStats, "language" | "filePath">>;
	byDirectory: Record<string, Omit<LineStats, "language" | "filePath">>;
	files: LineStats[];
	totals: { code: number; blank: number; comment: number; total: number };
}

export interface CountProjectOptions {
	ignore?: string[];
	extensions?: string[];
}

const EXT_TO_LANG: Record<string, string> = {
	".ts": "TypeScript",
	".tsx": "TypeScript",
	".js": "JavaScript",
	".jsx": "JavaScript",
	".mjs": "JavaScript",
	".py": "Python",
	".go": "Go",
	".rs": "Rust",
};

const DEFAULT_IGNORE = ["node_modules", ".git", "dist", "build", ".8gent"];

interface CommentStyle {
	line: string[];
	blockStart?: string;
	blockEnd?: string;
}

const COMMENT_STYLES: Record<string, CommentStyle> = {
	TypeScript: { line: ["//"], blockStart: "/*", blockEnd: "*/" },
	JavaScript: { line: ["//"], blockStart: "/*", blockEnd: "*/" },
	Go: { line: ["//"], blockStart: "/*", blockEnd: "*/" },
	Rust: { line: ["//"], blockStart: "/*", blockEnd: "*/" },
	Python: { line: ["#"], blockStart: '"""', blockEnd: '"""' },
};

export function countLines(filePath: string): LineStats | null {
	const lang = EXT_TO_LANG[extname(filePath).toLowerCase()];
	if (!lang) return null;
	let raw: string;
	try {
		raw = readFileSync(filePath, "utf8");
	} catch {
		return null;
	}
	const style = COMMENT_STYLES[lang];
	let code = 0;
	let blank = 0;
	let comment = 0;
	let inBlock = false;
	for (const rawLine of raw.split("\n")) {
		const line = rawLine.trim();
		if (line === "") {
			blank++;
			continue;
		}
		if (!inBlock && style.blockStart && line.includes(style.blockStart)) {
			const after = line.indexOf(style.blockStart) + style.blockStart.length;
			if (style.blockEnd && line.indexOf(style.blockEnd, after) !== -1) {
				comment++;
				continue;
			}
			inBlock = true;
			comment++;
			continue;
		}
		if (inBlock) {
			comment++;
			if (style.blockEnd && line.includes(style.blockEnd)) inBlock = false;
			continue;
		}
		style.line.some((p) => line.startsWith(p)) ? comment++ : code++;
	}
	return {
		code,
		blank,
		comment,
		total: code + blank + comment,
		language: lang,
		filePath,
	};
}

function collectFiles(dir: string, ignore: string[], exts: string[]): string[] {
	const results: string[] = [];
	let entries: string[];
	try {
		entries = readdirSync(dir);
	} catch {
		return results;
	}
	for (const entry of entries) {
		if (ignore.includes(entry)) continue;
		const full = join(dir, entry);
		if (statSync(full).isDirectory()) {
			results.push(...collectFiles(full, ignore, exts));
		} else if (
			exts.length === 0 ||
			exts.includes(extname(entry).toLowerCase())
		) {
			results.push(full);
		}
	}
	return results;
}

function empty() {
	return { code: 0, blank: 0, comment: 0, total: 0 };
}
function add(acc: ReturnType<typeof empty>, s: LineStats) {
	acc.code += s.code;
	acc.blank += s.blank;
	acc.comment += s.comment;
	acc.total += s.total;
}

export function countProject(
	dir: string,
	options: CountProjectOptions = {},
): ProjectStats {
	const ignore = [...DEFAULT_IGNORE, ...(options.ignore ?? [])];
	const exts = (options.extensions ?? Object.keys(EXT_TO_LANG)).map((e) =>
		e.startsWith(".") ? e : `.${e}`,
	);
	const byLanguage: ProjectStats["byLanguage"] = {};
	const byDirectory: ProjectStats["byDirectory"] = {};
	const totals = empty();
	const files: LineStats[] = [];
	for (const f of collectFiles(dir, ignore, exts)) {
		const s = countLines(f);
		if (!s) continue;
		files.push(s);
		if (!byLanguage[s.language]) byLanguage[s.language] = empty();
		add(byLanguage[s.language], s);
		const dirKey = f.replace(/\/[^/]+$/, "");
		if (!byDirectory[dirKey]) byDirectory[dirKey] = empty();
		add(byDirectory[dirKey], s);
		add(totals, s);
	}
	return { byLanguage, byDirectory, files, totals };
}
