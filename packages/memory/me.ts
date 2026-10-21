/**
 * ME profile folder (#4708, slice 1).
 *
 * `~/.8gent/me/` (override: EIGHT_ME_DIR) holds one fact per markdown file plus
 * `ME.md`, the index. The folder is the truth: plain files the person owns,
 * readable and editable by hand. Behind EIGHT_ME=1, default off.
 *
 * Fact file shape:
 *   ---
 *   name: repo-truth
 *   description: which repo is the source of truth
 *   metadata:
 *     type: user          (user | feedback | project | reference)
 *   ---
 *   body text
 *
 * Index line shape (ME.md): `- [Title](file.md) - hook`
 *
 * Deterministic: matching is token overlap, ordering is score then name.
 * No embeddings, no network, no second store.
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { estimateTokens } from "./types.js";

type Env = Record<string, string | undefined>;

export const ME_TYPES = ["user", "feedback", "project", "reference"] as const;
export type MeType = (typeof ME_TYPES)[number];

export interface MeFact {
	name: string;
	description: string;
	type: MeType;
	body: string;
	/** File name inside the folder, e.g. `repo-truth.md`. */
	file: string;
}

export interface Me {
	dir: string;
	index: string;
	facts: MeFact[];
}

const INDEX_FILE = "ME.md";
const CLAUDE_INDEX_FILE = "MEMORY.md";

export function meEnabled(env: Env = process.env): boolean {
	return env.EIGHT_ME === "1";
}

export function meDir(env: Env = process.env): string {
	return env.EIGHT_ME_DIR || path.join(os.homedir(), ".8gent", "me");
}

/** Parse one fact file. Returns null when the frontmatter shape is missing. */
export function parseFact(file: string, text: string): MeFact | null {
	const m = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/.exec(text);
	if (!m) return null;
	let name = "";
	let description = "";
	let type = "";
	for (const raw of m[1].split(/\r?\n/)) {
		const kv = /^\s*([A-Za-z_]+):\s*(.*)$/.exec(raw);
		if (!kv) continue;
		const value = kv[2].trim().replace(/^["'](.*)["']$/, "$1");
		if (kv[1] === "name") name = value;
		else if (kv[1] === "description") description = value;
		else if (kv[1] === "type") type = value;
	}
	if (!name || !(ME_TYPES as readonly string[]).includes(type)) return null;
	return { name, description, type: type as MeType, body: m[2].trim(), file };
}

function readIfFile(p: string): string | null {
	try {
		return fs.statSync(p).isFile() ? fs.readFileSync(p, "utf8") : null;
	} catch {
		return null;
	}
}

/** Load the folder. A missing folder is an empty profile, never an error. */
export function loadMe(dir: string): Me {
	const index = readIfFile(path.join(dir, INDEX_FILE)) ?? "";
	const facts: MeFact[] = [];
	let entries: string[] = [];
	try {
		entries = fs.readdirSync(dir).sort();
	} catch {
		return { dir, index, facts };
	}
	for (const f of entries) {
		if (!f.endsWith(".md") || f === INDEX_FILE || f === CLAUDE_INDEX_FILE) continue;
		const text = readIfFile(path.join(dir, f));
		if (text === null) continue;
		const fact = parseFact(f, text);
		if (fact) facts.push(fact);
	}
	facts.sort((a, b) => a.name.localeCompare(b.name));
	return { dir, index, facts };
}

const STOP = new Set([
	"the",
	"and",
	"for",
	"are",
	"but",
	"not",
	"you",
	"your",
	"with",
	"this",
	"that",
	"from",
	"have",
	"what",
	"which",
	"when",
	"where",
	"how",
	"why",
	"can",
	"could",
	"would",
	"should",
	"about",
	"into",
	"just",
	"its",
	"was",
	"were",
	"will",
	"all",
]);

function tokens(text: string): Set<string> {
	const out = new Set<string>();
	for (const w of text.toLowerCase().split(/[^a-z0-9]+/)) {
		if (w.length >= 3 && !STOP.has(w)) out.add(w);
	}
	return out;
}

/** Number of distinct query words found in the fact's name, description or body. */
export function scoreFact(fact: MeFact, query: Set<string>): number {
	const have = tokens(`${fact.name} ${fact.description} ${fact.body}`);
	let n = 0;
	for (const q of query) if (have.has(q)) n++;
	return n;
}

/**
 * The ME.md index verbatim, then the bodies of facts matching the query,
 * best score first (ties by name), trimmed to maxTokens.
 */
export function buildMeContext(me: Me, query?: string, maxTokens = 1500): string {
	const parts: string[] = [];
	if (me.index.trim()) parts.push(me.index.trim());
	const q = tokens(query ?? "");
	if (q.size > 0) {
		const ranked = me.facts
			.map((f) => ({ f, s: scoreFact(f, q) }))
			.filter((x) => x.s > 0)
			.sort((a, b) => b.s - a.s || a.f.name.localeCompare(b.f.name));
		for (const { f } of ranked) parts.push(`### ${f.name}\n${f.body}`);
	}
	const out = parts.join("\n\n");
	if (estimateTokens(out) <= maxTokens) return out;
	return out.slice(0, Math.max(0, maxTokens * 4));
}

/** The `## ME` block for one turn, or null when the flag is off or the folder is empty. */
export function meBlockForTurn(query: string, env: Env = process.env): string | null {
	if (!meEnabled(env)) return null;
	const body = buildMeContext(loadMe(meDir(env)), query);
	return body ? `## ME\n${body}` : null;
}

export function slugify(text: string): string {
	const s = text
		.toLowerCase()
		.split(/[^a-z0-9]+/)
		.filter(Boolean)
		.slice(0, 6)
		.join("-")
		.slice(0, 48)
		.replace(/-+$/, "");
	return s || "note";
}

function oneLine(s: string): string {
	return s.replace(/\s+/g, " ").trim();
}

function appendIndexLine(dir: string, line: string): void {
	const p = path.join(dir, INDEX_FILE);
	const cur = readIfFile(p) ?? "";
	const sep = cur === "" || cur.endsWith("\n") ? "" : "\n";
	fs.writeFileSync(p, `${cur}${sep}${line}\n`);
}

/** Write `<slug>.md` with type user and append its index line. Never overwrites. */
export function addFact(dir: string, text: string): MeFact {
	const clean = oneLine(text);
	if (!clean) throw new Error("Nothing to add.");
	fs.mkdirSync(dir, { recursive: true });
	const base = slugify(clean);
	let name = base;
	for (let i = 2; fs.existsSync(path.join(dir, `${name}.md`)); i++) name = `${base}-${i}`;
	const description = clean.length > 80 ? `${clean.slice(0, 77)}...` : clean;
	const file = `${name}.md`;
	fs.writeFileSync(
		path.join(dir, file),
		`---\nname: ${name}\ndescription: ${description}\nmetadata:\n  type: user\n---\n${clean}\n`,
		{ flag: "wx" },
	);
	appendIndexLine(dir, `- [${name}](${file}) - ${description}`);
	return { name, description, type: "user", body: clean, file };
}

/** Remove one fact file and its index line. Returns false when no such fact. */
export function forgetFact(dir: string, name: string): boolean {
	const fact = loadMe(dir).facts.find((f) => f.name === name || f.file === name);
	if (!fact) return false;
	fs.rmSync(path.join(dir, fact.file));
	const p = path.join(dir, INDEX_FILE);
	const cur = readIfFile(p);
	if (cur !== null) {
		const kept = cur.split("\n").filter((l) => !l.includes(`](${fact.file})`));
		fs.writeFileSync(p, kept.join("\n"));
	}
	return true;
}

export interface ImportResult {
	imported: number;
	skipped: number;
	ignored: number;
	index: "copied" | "kept" | "none";
}

/**
 * Copy fact files with the frontmatter shape from `src` into `dest`, skipping
 * names that already exist. MEMORY.md becomes ME.md when ME.md is absent.
 */
export function importMe(src: string, dest: string): ImportResult {
	const res: ImportResult = { imported: 0, skipped: 0, ignored: 0, index: "none" };
	fs.mkdirSync(dest, { recursive: true });
	for (const f of fs.readdirSync(src).sort()) {
		if (!f.endsWith(".md")) continue;
		const text = readIfFile(path.join(src, f));
		if (text === null) continue;
		if (f === CLAUDE_INDEX_FILE || f === INDEX_FILE) {
			const target = path.join(dest, INDEX_FILE);
			if (fs.existsSync(target)) res.index = "kept";
			else {
				fs.writeFileSync(target, text);
				res.index = "copied";
			}
			continue;
		}
		if (!parseFact(f, text)) {
			res.ignored++;
			continue;
		}
		const target = path.join(dest, f);
		if (fs.existsSync(target)) res.skipped++;
		else {
			fs.writeFileSync(target, text);
			res.imported++;
		}
	}
	return res;
}
