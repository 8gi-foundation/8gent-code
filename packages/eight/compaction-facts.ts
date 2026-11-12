/**
 * compaction-facts.ts - exact facts that survive a compaction (#241).
 *
 * A written summary drops file names, failing commands and error lines first.
 * Before summarising, these are pulled out of the old history with plain
 * regex (no model call) and appended after the summary as a "Kept exactly"
 * block. Every item goes through the secret scrubber and then quoteLines, the
 * same quoting #226 uses, so an item cannot open a turn or a block tag.
 */
import { quoteLines } from "./compaction";
import { scrub } from "./secret-scanner";

type Message = { role: string; content: string };

export const MAX_FILES = 20;
export const MAX_COMMANDS = 10;
export const MAX_ERRORS = 10;
export const MAX_ITEM_CHARS = 200;

export interface Facts {
	files: string[];
	commands: string[];
	errors: string[];
}

export const emptyFacts = (): Facts => ({ files: [], commands: [], errors: [] });

const COMMAND_RE = /"command"\s*:\s*"((?:[^"\\]|\\.)*)"/g;
const EXIT_RE = /^Exit code (-?\d+):/;
const ERROR_RE =
	/\b(?:error|fatal|exception|panic|traceback|ERR!|FAIL(?:ED)?)\b|\b[A-Z][A-Za-z]*(?:Error|Exception)\b/;

/** One line, no control or format characters, scrubbed of secrets, cut to size. */
function clean(item: string): string {
	const oneLine = item.replace(/[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]+/gu, " ").trim();
	return scrub(oneLine).scrubbed.slice(0, MAX_ITEM_CHARS);
}

function unescapeJson(s: string): string {
	try {
		return JSON.parse(`"${s}"`);
	} catch {
		return s;
	}
}

/** Add `items` to `list`, newest last, no duplicates, only the newest `cap` kept. */
function push(list: string[], items: string[], cap: number): string[] {
	const out = list.filter((x) => !items.includes(x)).concat(items);
	return out.slice(-cap);
}

/** Facts in `messages`, merged onto `prior` (earlier compactions). `files` come from FileTracker. */
export function extractFacts(messages: Message[], files: string[], prior = emptyFacts()): Facts {
	const commands: string[] = [];
	const errors: string[] = [];
	let lastCommand: string | null = null;
	for (const m of messages) {
		COMMAND_RE.lastIndex = 0;
		for (let c = COMMAND_RE.exec(m.content); c; c = COMMAND_RE.exec(m.content))
			lastCommand = unescapeJson(c[1]);
		const exit = EXIT_RE.exec(m.content);
		if (exit && exit[1] !== "0" && lastCommand) commands.push(`${lastCommand} (exit ${exit[1]})`);
		if (m.role === "tool" || m.content.startsWith("[tool_result]") || exit)
			for (const line of m.content.split(/\r\n?|\n/))
				if (ERROR_RE.test(line) && !EXIT_RE.test(line)) errors.push(line);
	}
	return {
		files: push(prior.files, files.map(clean).filter(Boolean), MAX_FILES),
		commands: push(prior.commands, commands.map(clean).filter(Boolean), MAX_COMMANDS),
		errors: push(prior.errors, errors.map(clean).filter(Boolean), MAX_ERRORS),
	};
}

/** The block appended verbatim after the model's summary. Empty when there is nothing to keep. */
export function renderKept(f: Facts): string {
	const part = (title: string, items: string[]) =>
		items.length ? [`${title}:`, quoteLines(items.join("\n"))] : [];
	const body = [
		...part("Files read or edited", f.files),
		...part("Commands that failed", f.commands),
		...part("Error lines", f.errors),
	];
	return body.length ? ["## Kept exactly", ...body].join("\n") : "";
}

/** Share of `expected` (scrubbed, as kept) found verbatim in `text`. */
export function survival(text: string, expected: string[]): number {
	if (!expected.length) return 1;
	return expected.filter((e) => text.includes(clean(e))).length / expected.length;
}
