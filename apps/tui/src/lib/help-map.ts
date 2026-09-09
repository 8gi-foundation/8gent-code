/**
 * /help as a map of the product.
 *
 * Pure functions: input is the slash registry (what this build can actually
 * run) and a column width; output is lines of text. Nothing here touches
 * React, Ink or the registry loader, so it is fully testable.
 *
 * Three modes:
 *   /help          one screen grouped by what a person is trying to do
 *   /help all      every registered command, one per line, never wrapping
 *   /help <name>   one command: description, usage, aliases
 *
 * The map is declared as sections of items. Each item names the commands it
 * depends on; an item is printed only when every one of those commands is in
 * the registry, and a section is printed only when at least one of its
 * command-bearing items survives. A build that lacks a command therefore
 * never advertises it.
 */

import { truncate, wrapText } from "./text.js";

/** The subset of a registry entry that help needs. */
export interface HelpEntry {
	token: string;
	name: string;
	canonicalName: string;
	description: string;
	usage?: string;
	kind: "builtin" | "skill";
}

interface MapItem {
	/** Registry names (without slash) this item depends on. Empty = prose. */
	commands: string[];
	/** What to print. */
	text: string;
	/** Shorter form used when `text` does not fit the column. */
	short?: string;
}

interface MapSection {
	heading: string;
	items: MapItem[];
}

const cmd = (name: string, text?: string): MapItem => ({
	commands: [name],
	text: text ?? `/${name}`,
});

const prose = (text: string, short?: string): MapItem => ({ commands: [], text, short });

/**
 * The product map. Order matters: it is the order a new person meets the
 * product. The "Work" section lists the three most useful work commands in
 * the registry after the core trio: /goal runs a task to completion on its
 * own, /term opens a shell or an agent CLI in a tab, /github reaches issues
 * and PRs without leaving the session.
 */
export const HELP_MAP: MapSection[] = [
	{
		heading: "Start here",
		items: [
			prose("ask a question in plain words", "ask in plain words"),
			{
				commands: ["model", "provider"],
				text: "/model and /provider choose what answers",
				short: "/model and /provider",
			},
			cmd("settings"),
			cmd("skills"),
		],
	},
	{
		heading: "See what is going on",
		items: [
			cmd("status"),
			cmd("plan"),
			cmd("kanban", "/kanban (Ctrl+K)"),
			prose("tab bar: Shift+Tab cycles, Esc back to chat", "Shift+Tab cycles tabs"),
		],
	},
	{
		heading: "Work",
		items: [
			cmd("build", "/build <task>"),
			cmd("design", "/design [task]"),
			cmd("evidence"),
			cmd("goal", "/goal <goal>"),
			cmd("term"),
			cmd("github"),
		],
	},
	{
		heading: "Notes and ideas",
		items: [cmd("notes", "/notes (Ctrl+N)"), cmd("ideas"), cmd("btw"), cmd("questions")],
	},
	{
		heading: "Voice and music",
		items: [cmd("voice"), cmd("dj", "/dj open"), cmd("dj", "/dj close (Ctrl+D)")],
	},
	{
		heading: "Session",
		items: [cmd("history"), cmd("clear"), cmd("quit"), cmd("telegram")],
	},
];

const MIN_WIDTH = 16;
const INDENT = "  ";
const GAP = "   ";

function clampWidth(width: number): number {
	return Number.isFinite(width) && width >= MIN_WIDTH ? Math.floor(width) : MIN_WIDTH;
}

/** Registered command names (canonical names and aliases, without slash). */
function registeredNames(entries: HelpEntry[]): Set<string> {
	const names = new Set<string>();
	for (const e of entries) {
		names.add(e.name);
		names.add(e.canonicalName);
	}
	return names;
}

/** Flow items onto lines no wider than `width`, breaking only between items. */
function flow(items: MapItem[], width: number): string[] {
	const budget = Math.max(1, width - INDENT.length);
	const lines: string[] = [];
	let current = "";
	for (const item of items) {
		const text = item.text.length > budget && item.short ? item.short : item.text;
		const piece = truncate(text, budget);
		if (current.length === 0) {
			current = piece;
		} else if (current.length + GAP.length + piece.length <= budget) {
			current = `${current}${GAP}${piece}`;
		} else {
			lines.push(INDENT + current);
			current = piece;
		}
	}
	if (current.length > 0) lines.push(INDENT + current);
	return lines;
}

/** The one-screen map. */
export function renderHelpMap(entries: HelpEntry[], width: number): string[] {
	const w = clampWidth(width);
	const have = registeredNames(entries);
	const out: string[] = [];

	for (const section of HELP_MAP) {
		const visible = section.items.filter((item) => item.commands.every((c) => have.has(c)));
		const hasCommand = visible.some((item) => item.commands.length > 0);
		if (!hasCommand) continue;
		out.push(truncate(section.heading, w));
		out.push(...flow(visible, w));
	}

	const footer = "/help all lists every command. /help <name> shows one command's usage.";
	out.push(footer.length <= w ? footer : truncate("/help all, /help <name>", w));
	return out;
}

/** One entry per canonical command: builtin canonicals first, then skills, each sorted. */
function canonicalEntries(entries: HelpEntry[]): HelpEntry[] {
	const seen = new Set<string>();
	const canonical: HelpEntry[] = [];
	for (const e of entries) {
		if (e.name !== e.canonicalName) continue;
		if (seen.has(`${e.kind}:${e.canonicalName}`)) continue;
		seen.add(`${e.kind}:${e.canonicalName}`);
		canonical.push(e);
	}
	const byKind = (kind: HelpEntry["kind"]) =>
		canonical.filter((e) => e.kind === kind).toSorted((a, b) => a.name.localeCompare(b.name));
	return [...byKind("builtin"), ...byKind("skill")];
}

/** Every command, one per line, truncated so no line wraps. */
export function renderHelpAll(entries: HelpEntry[], width: number): string[] {
	const w = clampWidth(width);
	const list = canonicalEntries(entries);
	if (list.length === 0) return ["No commands are registered."];

	// Name column: the longest name plus one, capped so a narrow column still
	// shows some of the description. Longer names push their own line only.
	const longest = list.reduce((max, e) => Math.max(max, e.name.length + 1), 0);
	const nameCol = Math.min(16, Math.max(8, Math.floor(w * 0.45)), longest);
	const header = `${list.length} commands. /help <name> shows one command's usage.`;
	const out: string[] = [header.length <= w ? header : `${list.length} commands`];
	let lastKind: HelpEntry["kind"] | null = null;
	for (const e of list) {
		if (e.kind !== lastKind) {
			out.push(e.kind === "skill" ? "Skills" : "Built in");
			lastKind = e.kind;
		}
		const name = `/${e.name}`.padEnd(nameCol);
		out.push(truncate(`${INDENT}${name} ${e.description}`, w));
	}
	return out;
}

/** One command: name, description, usage and aliases. Name may carry a slash. */
export function renderHelpCommand(entries: HelpEntry[], name: string, width: number): string[] {
	const w = clampWidth(width);
	const wanted = name.trim().toLowerCase().replace(/^\//, "");
	if (wanted.length === 0) return renderHelpMap(entries, w);

	const hit = entries.find((e) => e.name.toLowerCase() === wanted);
	if (!hit) {
		return [truncate(`No command named /${wanted}. /help all lists every command.`, w)];
	}

	const family = entries.filter(
		(e) => e.kind === hit.kind && e.canonicalName === hit.canonicalName,
	);
	const canonical = family.find((e) => e.name === e.canonicalName) ?? hit;
	const aliases = family.filter((e) => e.name !== canonical.name).map((e) => `/${e.name}`);

	// One command is the whole point of this view, so wrap rather than truncate.
	const body = Math.max(1, w - INDENT.length);
	const indent = (lines: string[]) => lines.map((l) => INDENT + l);
	const out: string[] = [truncate(`/${canonical.name}`, w)];
	out.push(...indent(wrapText(canonical.description, body)));
	if (canonical.usage) out.push(...indent(wrapText(`Usage: ${canonical.usage}`, body)));
	if (aliases.length > 0) out.push(...indent(wrapText(`Also: ${aliases.join(", ")}`, body)));
	if (canonical.kind === "skill") out.push(`${INDENT}Skill: expands to its prompt`);
	return out;
}

/** Dispatch on the arguments given to /help. */
export function renderHelp(entries: HelpEntry[], args: string[], width: number): string[] {
	const first = (args[0] ?? "").trim().toLowerCase();
	if (first.length === 0) return renderHelpMap(entries, width);
	if (first === "all") return renderHelpAll(entries, width);
	return renderHelpCommand(entries, first, width);
}
