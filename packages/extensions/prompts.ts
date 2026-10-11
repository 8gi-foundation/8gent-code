/**
 * 8gent Code - prompt templates (G4).
 *
 * Each Markdown file in ~/.8gent/prompts/ is a command: review.md is /review.
 * Typing `/review src/app.ts strict` sends the file's body with its
 * placeholders filled in:
 *
 *   $1, $2, ...      the Nth word of the arguments ("quoted words" stay one)
 *   $@ or $ARGUMENTS all of the arguments, as typed
 *
 * An optional front matter block gives the menu a description:
 *
 *   ---
 *   description: Review a file for bugs
 *   ---
 *   Review $1 for correctness bugs. Mode: $2.
 *
 * Templates are text only: expanding one sends a user message, it runs
 * nothing. The slash menu wiring is L6's.
 */

import * as fs from "node:fs";
import * as path from "node:path";

export interface PromptTemplate {
	/** The command name, from the file name: review.md is "review". */
	name: string;
	description: string;
	body: string;
	file: string;
}

const NAME = /^[a-z0-9][a-z0-9_-]{0,63}$/;

export function defaultPromptsDir(): string {
	return path.join(process.env.HOME || process.env.USERPROFILE || "~", ".8gent", "prompts");
}

/** Split an optional leading "---" front matter block from the body. */
export function parseTemplate(text: string): { description: string; body: string } {
	const normalized = text.replace(/\r\n/g, "\n");
	const m = normalized.match(/^---\n([\s\S]*?)\n---\n?([\s\S]*)$/);
	if (!m) return { description: "", body: normalized.trim() };
	const desc = m[1].match(/^description:\s*(.*)$/m)?.[1]?.trim() ?? "";
	return { description: desc.replace(/^["']|["']$/g, ""), body: m[2].trim() };
}

/**
 * Templates in the folders given, later folders winning on a name clash.
 * Files whose name is not a valid command name are skipped. Sorted by name.
 */
export function loadPromptTemplates(dirs: string[] = [defaultPromptsDir()]): PromptTemplate[] {
	const byName = new Map<string, PromptTemplate>();
	for (const dir of dirs) {
		if (!fs.existsSync(dir)) continue;
		for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
			if (!entry.isFile() || path.extname(entry.name).toLowerCase() !== ".md") continue;
			const name = path.basename(entry.name, path.extname(entry.name)).toLowerCase();
			if (!NAME.test(name)) continue;
			const file = path.join(dir, entry.name);
			const { description, body } = parseTemplate(fs.readFileSync(file, "utf-8"));
			byName.set(name, { name, description, body, file });
		}
	}
	return [...byName.values()].sort((a, b) => a.name.localeCompare(b.name));
}

/** Split arguments on whitespace; "double" or 'single' quotes keep words together. */
export function splitArgs(args: string): string[] {
	const out: string[] = [];
	const re = /"([^"]*)"|'([^']*)'|(\S+)/g;
	for (const m of args.matchAll(re)) out.push(m[1] ?? m[2] ?? m[3]);
	return out;
}

/**
 * Fill a template body. $N past the last argument becomes empty. A template
 * with no placeholder at all gets the arguments appended on a new line, so
 * `/review this file` never drops what was typed.
 */
export function expandTemplate(body: string, args: string): string {
	const words = splitArgs(args);
	const all = args.trim();
	let used = false;
	const out = body.replace(/\$(ARGUMENTS|@|\d+)/g, (_, key: string) => {
		used = true;
		if (key === "ARGUMENTS" || key === "@") return all;
		const n = Number(key);
		return n >= 1 ? (words[n - 1] ?? "") : "";
	});
	if (!used && all) return `${out}\n\n${all}`;
	return out;
}

/**
 * Expand "/name args" when name is a template. Null when the input is not a
 * slash command or no template has that name.
 */
export function expandPromptCommand(input: string, templates: PromptTemplate[]): string | null {
	const m = input.match(/^\/([a-z0-9][a-z0-9_-]*)(?:\s+([\s\S]*))?$/i);
	if (!m) return null;
	const t = templates.find((x) => x.name === m[1].toLowerCase());
	if (!t) return null;
	return expandTemplate(t.body, m[2] ?? "");
}
