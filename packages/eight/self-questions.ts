/**
 * Questions about 8gent itself, and chat in a plain home folder (#4791).
 *
 * A phone session in a home folder with no repo got "why theslah at3vnkt working"
 * (a typo'd "why the slash ain't working"). 8gent answered with 38 tool calls:
 * find ~ for .git, git -C and npm test in a sibling repo, sed on files under
 * node_modules. Twenty minutes, no answer. The answer was in 8gent's own slash
 * registry. The act-first prompt rules (RULES_SEGMENT in prompts/system-prompt.ts)
 * have no case for a question whose answer is already known to the harness.
 *
 * Same shape as small-talk.ts: decided by a pattern, not a model call, and the
 * turn offers no tools. A self question gets the live slash help injected as a
 * harness note, so the answer is a read, not a search. A chat message in a
 * plain home folder gets no tools either, and is told to ask what to work on.
 *
 * Deliberately conservative. A self question needs a strong 8gent term (slash,
 * 8gent, yolo, api keys, hotkeys, or a real /command), a question cue, and no
 * work verb ("fix the slash command parser" is work and keeps its tools). The
 * 8gent source checkout is exempt: there the slash code is the project.
 */

import { existsSync } from "node:fs";
import { join } from "node:path";

function flatten(text: string): string {
	return text
		.toLowerCase()
		.replace(/^\[mode: [^\]]*\]\s*/, "")
		.replace(/['’]/g, "")
		.replace(/[^a-z0-9 ]+/g, " ")
		.replace(/\s+/g, " ")
		.trim();
}

/** Levenshtein distance, bailing out early past `max`. */
function editDistance(a: string, b: string, max: number): number {
	if (Math.abs(a.length - b.length) > max) return max + 1;
	let prev = Array.from({ length: b.length + 1 }, (_, i) => i);
	for (let i = 1; i <= a.length; i++) {
		const cur = [i];
		let rowMin = i;
		for (let j = 1; j <= b.length; j++) {
			cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
			rowMin = Math.min(rowMin, cur[j]);
		}
		if (rowMin > max) return max + 1;
		prev = cur;
	}
	return prev[b.length];
}

/** True when `token` is `term`, or holds a stretch one edit away from it ("theslah" holds "slah"). */
function fuzzyHas(token: string, term: string): boolean {
	if (token === term) return true;
	const n = term.length;
	if (token.length < n - 1) return false;
	for (let len = n - 1; len <= n + 1; len++) {
		for (let i = 0; i + len <= token.length; i++) {
			if (editDistance(token.slice(i, i + len), term, 1) <= 1) return true;
		}
	}
	return false;
}

/** Terms that point at 8gent on their own. `fuzzy`: typos tolerated. */
const STRONG_EXACT = new Set([
	"8gent",
	"yolo",
	"apikey",
	"apikeys",
	"hotkey",
	"hotkeys",
	"privacy",
]);
const STRONG_FUZZY = ["slash", "slashes", "hotkeys"];
/** "api key(s)" and "8gent code" are two tokens. */
const STRONG_PHRASE = /\bapi keys?\b/;

const CUE = new Set([
	"why",
	"how",
	"what",
	"whats",
	"where",
	"which",
	"when",
	"who",
	"can",
	"cant",
	"cannot",
	"does",
	"doesnt",
	"do",
	"dont",
	"is",
	"isnt",
	"are",
	"arent",
	"aint",
	"not",
	"working",
	"work",
	"works",
	"broken",
	"wont",
	"help",
	"explain",
	"show",
	"list",
	"tell",
	"use",
	"using",
	"set",
	"enable",
	"disable",
	"turn",
	"change",
]);

/** A work verb means a task, not a question: the turn keeps its tools. */
const WORK = new Set([
	"fix",
	"implement",
	"refactor",
	"edit",
	"patch",
	"commit",
	"push",
	"deploy",
	"rename",
	"delete",
	"remove",
	"write",
	"create",
	"build",
	"debug",
	"test",
	"tests",
	"investigate",
]);

/** Slash command names mentioned as "/name" (case-folded), checked against the live registry. */
function mentionedCommands(text: string, names: ReadonlySet<string>): string[] {
	const out: string[] = [];
	for (const m of text.toLowerCase().matchAll(/(?:^|\s)\/([a-z][a-z-]*)(?=[\s?.,!]|$)/g)) {
		if (names.has(m[1])) out.push(m[1]);
	}
	return out;
}

/** The 8gent source checkout: its own slash and agent code is the project there. */
export function isHarnessSource(dir: string): boolean {
	try {
		return existsSync(join(dir, "packages", "eight", "agent.ts"));
	} catch {
		return false;
	}
}

/**
 * True when the message is a question about 8gent itself. `commandNames` are the
 * built-in slash names and aliases, so a real "/mode" counts and "/usr/bin" does not.
 */
export function isSelfQuestion(
	text: string,
	commandNames: ReadonlySet<string> = new Set(),
): boolean {
	const flat = flatten(text);
	if (flat === "" || flat.length > 200) return false;
	const tokens = flat.split(" ");
	if (tokens.some((t) => WORK.has(t))) return false;
	const strong =
		tokens.some(
			(t) => STRONG_EXACT.has(t) || STRONG_FUZZY.some((s) => t.length >= 4 && fuzzyHas(t, s)),
		) ||
		STRONG_PHRASE.test(flat) ||
		mentionedCommands(text, commandNames).length > 0;
	if (!strong) return false;
	return text.includes("?") || tokens.some((t) => CUE.has(t));
}

/** The built-in slash commands, from the live registry, or null when it cannot be loaded. */
export async function loadSlashFacts(): Promise<{
	names: Set<string>;
	help: string;
	lines: Map<string, string>;
} | null> {
	try {
		const mod = await import("../../apps/tui/src/lib/slash-commands.js");
		const names = new Set<string>();
		const lines = new Map<string, string>();
		for (const c of mod.BUILT_IN_SLASH_COMMANDS) {
			const line = `  ${c.usage ?? `/${c.name}`} - ${c.description}`;
			for (const n of [c.name, ...c.aliases]) {
				names.add(n);
				lines.set(n, line);
			}
		}
		return { names, help: mod.formatSlashHelp(false), lines };
	} catch {
		return null;
	}
}

/**
 * The harness note a self-question turn carries: the facts, and the rule that the
 * answer comes from them. Commands the message names get their own line first.
 */
export function selfQuestionNote(
	text: string,
	facts: { help: string; lines: Map<string, string> } | null,
): string {
	const named = facts
		? [...new Set(mentionedCommands(text, new Set(facts.lines.keys())))].map(
				(n) => facts.lines.get(n) as string,
			)
		: [];
	return [
		"[8GENT QUESTION] The person is asking about 8gent itself, not about their files. The message may have typos: read it for what they mean.",
		"Answer from the facts below. No tools this turn: do not list folders, search for repos, run git or tests, or open files under node_modules.",
		"If the facts do not cover it, say so plainly, point to /help or /help all, and ask what they were trying to do.",
		"",
		...(named.length > 0 ? ["Commands they named:", ...new Set(named), ""] : []),
		facts?.help ?? "Type /help to list the commands, /help all for every one.",
		"/mode sets how much 8gent may do on its own (Shift+Tab cycles it). /apikeys enters provider keys. /privacy shows what stayed on this machine.",
	].join("\n");
}

/**
 * Words that make a message a task or a pointer at files, so a plain home folder
 * does not hold the turn back from tools.
 */
const TASK = new Set([
	...WORK,
	"run",
	"install",
	"find",
	"search",
	"open",
	"read",
	"check",
	"look",
	"clone",
	"move",
	"pull",
	"git",
	"npm",
	"bun",
	"pip",
	"folder",
	"folders",
	"directory",
	"file",
	"files",
	"repo",
	"repos",
	"project",
	"projects",
	"code",
	"downloads",
	"documents",
	"desktop",
	"ls",
	"cd",
]);

/**
 * True when a message in a plain home folder is chat: short, and it names no task,
 * file or folder. Its first turn is answered without a tool tour (#4791).
 */
export function isHomeChat(text: string): boolean {
	const flat = flatten(text);
	if (flat === "" || flat.length > 160) return false;
	if (/[/~\\]|\.\w{1,5}\b/.test(text.replace(/\?+$/, ""))) return false;
	return !flat.split(" ").some((t) => TASK.has(t));
}

/** The harness note a plain-home chat turn carries. */
export const HOME_CHAT_NOTE =
	"[HOME FOLDER CHAT] The working folder is the person's home folder, not a project, and this is the start of the conversation. Answer in plain sentences from what you know. No tools this turn: do not look for repos, run git or tests, or list folders. If they need something done, ask what they want to work on.";
