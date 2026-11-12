/**
 * Learned audit file (#232 slice 1): one plain line per lesson the harness
 * stores, appended to <home>/.8gent/learned.jsonl, and `8gent learned` to read
 * them. Local file only, nothing leaves the device. Text is redacted before it
 * is written. Undo is not in this slice.
 */
import { appendFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { resolveHome } from "../core/home";
import { redact } from "../memory/redact";

export interface LearnedEntry {
	/** ISO time the lesson was stored. */
	at: string;
	/** Which system stored it, e.g. "memory" or "skills". */
	source: string;
	/** The lesson in plain words. */
	text: string;
	/** Where it came from: a session id, file or command. Optional. */
	where?: string;
}

export const learnedPath = (env: Record<string, string | undefined> = process.env): string =>
	join(resolveHome(env), ".8gent", "learned.jsonl");

/** Append one lesson. Returns false (and writes nothing) if the text is empty or the write fails. */
export function recordLearned(
	e: { source: string; text: string; where?: string },
	file: string = learnedPath(),
	now: () => Date = () => new Date(),
): boolean {
	const text = redact(e.text).replace(/\s+/g, " ").trim();
	if (!text || !e.source) return false;
	const entry: LearnedEntry = { at: now().toISOString(), source: e.source, text };
	if (e.where) entry.where = e.where;
	try {
		mkdirSync(dirname(file), { recursive: true });
		appendFileSync(file, `${JSON.stringify(entry)}\n`);
		return true;
	} catch {
		return false;
	}
}

/** Every readable line of the file, oldest first. A damaged line is skipped, not fatal. */
export function readLearned(file: string = learnedPath()): LearnedEntry[] {
	if (!existsSync(file)) return [];
	const out: LearnedEntry[] = [];
	for (const line of readFileSync(file, "utf8").split("\n")) {
		try {
			const e = JSON.parse(line);
			if (typeof e?.text === "string" && typeof e?.source === "string") out.push(e);
		} catch {}
	}
	return out;
}

/** `8gent learned`: one line per lesson, naming when, who stored it and where from. */
export function printLearned(file: string = learnedPath()): string[] {
	const all = readLearned(file);
	if (all.length === 0) return [`Nothing learned yet. Lessons are written to ${file}.`];
	return [
		`${all.length} thing${all.length === 1 ? "" : "s"} learned (${file}):`,
		...all.map((e) => `${e.at.slice(0, 10)}  ${e.source}: ${e.text}${e.where ? ` (from ${e.where})` : ""}`),
	];
}
