/**
 * First run with no model (T5): when nothing can answer, say how to connect one.
 *
 * A bare machine (no Ollama, no LM Studio, no keys) used to open to "READY"
 * with "providers 0/3" in the status bar and nothing else. Whether the card
 * shows is decided in lib/readiness.ts (#3290), the one answer the header
 * strip also renders from; this file holds the card's words, the key check
 * and the reason line.
 */

import { getProviderManager } from "../../../../packages/providers/index.js";
import {
	KEYS_FILE_DISPLAY,
	OLLAMA_RECOMMENDED,
	PHONE_LLAMA_RECOMMENDED,
} from "../../../../packages/self-autonomy/model-recipes.js";
import { isAndroidHost } from "../../../../packages/voice/termux.js";

/** Providers served by the local engines the status bar counts. "" = not chosen yet. */
export const LOCAL_ENGINE_PROVIDERS: ReadonlySet<string> = new Set([
	"",
	"8gent",
	"ollama",
	"lmstudio",
	"llama-server",
	"apfel",
	"apple-foundation",
]);

export type KeyStatus = "not-needed" | "present" | "missing";

/**
 * Does `provider` need an API key, and is one set (env or saved)? The TUI-only
 * "openrouter-free" spelling uses the OpenRouter key. Never throws.
 */
export function providerKeyStatus(
	provider: string,
	lookup: (name: string) => { needsKey: boolean; hasKey: boolean } = registryLookup,
): KeyStatus {
	const name = provider === "openrouter-free" ? "openrouter" : provider;
	if (LOCAL_ENGINE_PROVIDERS.has(name)) return "not-needed";
	try {
		const { needsKey, hasKey } = lookup(name);
		if (!needsKey) return "not-needed";
		return hasKey ? "present" : "missing";
	} catch {
		return "not-needed";
	}
}

function registryLookup(name: string): { needsKey: boolean; hasKey: boolean } {
	const pm = getProviderManager();
	if (!pm.isKnownProvider(name)) return { needsKey: false, hasKey: false };
	const config = pm.getProvider(name);
	return {
		needsKey: Boolean(config.apiKeyEnv || config.apiKeyRef),
		hasKey: Boolean(pm.getApiKey(name)),
	};
}

/**
 * The card's reason line from agent init's readiness result, naming the
 * engine and the address it was tried at, so a wrong OLLAMA_HOST is visible.
 * `reason` is provider-readiness's own wording ("not reachable", "no answer
 * within 3s", "http 500", "no models").
 */
export function unreachableLine(label: string, address: string, reason: string): string {
	const at = `${label} at ${address}`;
	if (reason === "not reachable") return `${at} did not answer.`;
	const within = /^no answer (within .+)$/.exec(reason);
	if (within) return `${at} did not answer ${within[1]}.`;
	if (reason === "no models") return `${at} has no models yet.`;
	return `${at} answered with ${reason}.`;
}

export interface GuidancePath {
	/** The path's number, shown as text so the order never rests on colour. */
	n: string;
	title: string;
	/** Lines to type or do, in order. */
	steps: string[];
}

export interface GuidanceCopy {
	label: string;
	lead: string;
	paths: GuidancePath[];
	/** The short-terminal form: lines per path, in path order (see COMPACT_BELOW_ROWS). */
	compact: string[][];
}

/**
 * Below this many terminal rows the card takes its 3-line compact form. The
 * full card is 13 rows; with the header, input and footer around it, a
 * shorter terminal would squeeze the input box (seen at 80x24).
 */
export const COMPACT_BELOW_ROWS = 30;

/**
 * A shell line with a `#` note, the note's spaces made non-breaking so a
 * narrow row moves the whole note down instead of splitting "7 GB" or
 * "hidden prompt" across two rows. A `#` note is a comment, so the line
 * still pastes and runs as it stands.
 */
function withNote(command: string, note: string): string {
	return `${command}   #\u00a0${note.replace(/ /g, "\u00a0")}`;
}

/**
 * A fetch-and-run install line that no longer fits one row, broken where the
 * shell allows it: the program and flags with a trailing backslash, then the
 * address and the pipe. Every row is a complete fragment, so the rows paste as
 * they stand and run as the one command. A soft wrap would cut it into three
 * rows that paste as three broken commands. Plain ASCII spaces only. The pipe
 * loses its spaces only when the second row would not fit with them. Anything
 * else, or a line that fits, comes back as it was.
 */
export function fitInstallStep(step: string, room: number): string {
	if (step.length <= room) return step;
	const m = /^(curl (?:-\S+ )*)(\S+) \| (\S+)$/.exec(step);
	if (!m) return step;
	const spaced = `${m[2]} | ${m[3]}`;
	return `${m[1]}\\\n${spaced.length <= room ? spaced : `${m[2]}|${m[3]}`}`;
}

/**
 * A compact line packed into rows of at most `room` cells, breaking only
 * after a comma, so a command ("/provider ollama") never splits across two
 * rows. Plain ASCII spaces, so the text still pastes as it stands. A piece
 * longer than the room stays whole and the terminal wraps it. Rows come back
 * joined by a newline.
 */
export function fitCompactLine(line: string, room: number): string {
	if (line.length <= room) return line;
	const pieces = line.split(/(?<=,) /);
	const rows: string[] = [];
	let cur = "";
	for (const piece of pieces) {
		if (cur !== "" && cur.length + 1 + piece.length > room) {
			rows.push(cur);
			cur = piece;
		} else cur = cur === "" ? piece : `${cur} ${piece}`;
	}
	if (cur !== "") rows.push(cur);
	return rows.join("\n");
}

/**
 * The card's words. Commands are the real ones and follow the published docs
 * (8gent.dev models/ollama and models/hosted): the Ollama install script and
 * library tag were checked against ollama.com, and the model and size come
 * from model-recipes.ts, shared with setup's provider check (#4220). Keys go in ~/.8gent/keys.env
 * via `8gent keys set <provider>` or `8gent keys` (the file `8gent keys status` reads and bin/8gent.ts loads).
 * Shell lines are pasteable as they stand: notes ride in `#` comments.
 */
export function guidanceCopy(
	platform: NodeJS.Platform = process.platform,
	env: Record<string, string | undefined> = process.env,
): GuidanceCopy {
	if (isAndroidHost(platform, env)) return phoneGuidanceCopy();
	const install =
		platform === "linux"
			? "curl -fsSL https://ollama.com/install.sh | sh"
			: `Install Ollama from ${OLLAMA_RECOMMENDED.site}`;
	return {
		label: "NO MODEL",
		lead: "8gent needs a model to answer. Pick one, or type /provider.",
		paths: [
			{
				n: "1",
				title: "Run a model on this machine (free, stays local)",
				steps: [
					install,
					withNote(`ollama pull ${OLLAMA_RECOMMENDED.pull}`, OLLAMA_RECOMMENDED.size),
					"In 8gent: /provider ollama",
				],
			},
			{
				n: "2",
				title: "Use a free hosted model, key from https://openrouter.ai/keys",
				steps: [
					withNote("8gent keys set openrouter", "hidden prompt, then restart"),
					`Or edit ${KEYS_FILE_DISPLAY} with 8gent keys`,
					"In 8gent: /provider openrouter, then /model auto:free",
				],
			},
		],
		compact: [
			[`Install Ollama (ollama.com), ollama pull ${OLLAMA_RECOMMENDED.pull}, /provider ollama`],
			["8gent keys set openrouter, restart 8gent", "/provider openrouter, then /model auto:free"],
		],
	};
}

/**
 * The phone's card (Android, Termux). Ollama is not the phone path: llama.cpp is a
 * Termux package and runs a small model on the phone itself. Local comes first and
 * nothing is installed for the person: each line is a command they choose to type.
 * The hosted path says plainly that messages leave the phone; the per-call cloud
 * notice still fires on every hosted turn.
 */
export function phoneGuidanceCopy(): GuidanceCopy {
	const r = PHONE_LLAMA_RECOMMENDED;
	return {
		label: "NO MODEL",
		lead: "8gent needs a model to answer. Pick one, or type /provider.",
		paths: [
			{
				n: "1",
				title: "Run a small model on this phone (free, nothing leaves the phone)",
				steps: [
					r.install,
					withNote(r.serve, `${r.size}, keep it running`),
					"In 8gent (a second Termux session): /provider llama-server",
				],
			},
			{
				n: "2",
				title: "Free hosted models (messages leave the phone), key from https://openrouter.ai/keys",
				steps: [
					withNote("8gent keys set openrouter", "hidden prompt, then restart"),
					"In 8gent: /provider openrouter, then /model auto:free",
				],
			},
		],
		compact: [
			[`${r.install}, ${r.serve}, /provider llama-server`],
			["8gent keys set openrouter, restart 8gent", "/provider openrouter, then /model auto:free"],
		],
	};
}

/**
 * The full "no model" guide as plain text, for the /provider command. It is
 * shown on request only, never as a standing card, so it cannot crowd the
 * onboarding conversation on a phone-sized terminal.
 */
export function guidanceText(
	copy: GuidanceCopy = guidanceCopy(),
	reason?: string | null,
	columns?: number,
): string {
	const lines = [`${copy.label}: ${copy.lead}`];
	if (reason) lines.push(reason);
	for (const path of copy.paths) {
		lines.push(`${path.n}. ${path.title}`);
		for (const step of path.steps) lines.push(`   ${step}`);
	}
	if (!columns) return lines.join("\n");
	return lines.map((line) => hangWrap(line, columns)).join("\n");
}

/**
 * Word-wrap one line to `columns`, indenting each continuation two cells past
 * the line's own indent, so a wrapped step still reads as part of its step
 * instead of landing at column 0 like a new item. Words longer than the row
 * (a URL) stay whole; the terminal breaks them.
 */
export function hangWrap(line: string, columns: number): string {
	if (line.length <= columns) return line;
	const lead = /^ */.exec(line)?.[0] ?? "";
	const hang = `${lead}  `;
	const out: string[] = [];
	let cur = lead;
	for (const word of line.trimStart().split(" ")) {
		const next = cur.trim() === "" ? cur + word : `${cur} ${word}`;
		if (next.length > columns && cur.trim() !== "") {
			out.push(cur);
			cur = hang + word;
		} else cur = next;
	}
	out.push(cur);
	return out.join("\n");
}
