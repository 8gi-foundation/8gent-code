/**
 * Learned audit file (#232 slice 1): one plain line per lesson the harness
 * stores, appended to <home>/.8gent/learned.jsonl, and `8gent learned` to read
 * them. Local file only, nothing leaves the device. Text is redacted before it
 * is written. Undo is not in this slice.
 */
import { closeSync, constants as fsc, existsSync, fchmodSync, fstatSync, mkdirSync, openSync, readFileSync, writeSync } from "node:fs";
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

/** Redact, then turn every C0/C1 control character (ESC, BEL, newline, ...) into a space and tidy spaces. */
const clean = (v: string): string =>
	redact(v)
		.replace(/[\u0000-\u001f\u007f-\u009f]/g, " ")
		.replace(/ +/g, " ")
		.trim();

/** Append one lesson. Returns false (and writes nothing) if the text is empty or the write fails. */
export function recordLearned(
	e: { source: string; text: string; where?: string },
	file: string = learnedPath(),
	now: () => Date = () => new Date(),
): boolean {
	const text = clean(e.text);
	const source = clean(e.source);
	if (!text || !source) return false;
	const entry: LearnedEntry = { at: now().toISOString(), source, text };
	const where = e.where ? clean(e.where) : "";
	if (where) entry.where = where;
	try {
		mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
		// Never through a symlink, regular file only, mode 0600 (same as openPrivate in local-runtime.ts).
		const fd = openSync(file, fsc.O_WRONLY | fsc.O_APPEND | fsc.O_CREAT | (fsc.O_NOFOLLOW ?? 0), 0o600);
		try {
			if (!fstatSync(fd).isFile()) return false;
			fchmodSync(fd, 0o600);
			writeSync(fd, `${JSON.stringify(entry)}\n`);
		} finally {
			closeSync(fd);
		}
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
			if (typeof e?.at === "string" && typeof e?.text === "string" && typeof e?.source === "string") out.push(e);
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
		...all.map(
			(e) =>
				`${clean(e.at).slice(0, 10)}  ${clean(e.source)}: ${clean(e.text)}${typeof e.where === "string" && clean(e.where) ? ` (from ${clean(e.where)})` : ""}`,
		),
	];
}
