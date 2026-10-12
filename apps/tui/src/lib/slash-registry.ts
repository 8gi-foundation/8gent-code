// Cross-workspace import of a package's public entrypoint (packages/*/index.ts).
// These are the canonical surface for inter-package use; deep imports would
// bypass each package's documented API. Suppressed by design.
// react-doctor-disable-next-line react-doctor/no-barrel-import
import { getSkillManager } from "../../../../packages/skills/index.js";
import { loadPromptTemplates } from "../../../../packages/extensions/prompts.js";
import {
	BUILT_IN_SLASH_COMMANDS,
	type BuiltInSlashCommandDef,
	type SlashCommand,
} from "./slash-commands.js";

type SlashRegistryKind = "builtin" | "skill" | "prompt";

export interface SlashRegistryEntry {
	token: string;
	name: string;
	canonicalName: string;
	description: string;
	usage?: string;
	kind: SlashRegistryKind;
	builtInName?: SlashCommand;
	skillName?: string;
	/** A prompt template (#3918 G4): the Markdown file it expands to. */
	templateFile?: string;
}

export interface SlashRegistry {
	entries: SlashRegistryEntry[];
	byToken: Map<string, SlashRegistryEntry>;
}

export interface ResolvedSlashInput {
	entry: SlashRegistryEntry;
	args: string[];
}

export function mergeSlashEntries(
	builtInEntries: SlashRegistryEntry[],
	skillEntries: SlashRegistryEntry[],
	promptEntries: SlashRegistryEntry[] = [],
): SlashRegistry {
	const byToken = new Map<string, SlashRegistryEntry>();
	// A template never shadows a built-in or a skill of the same name: it is
	// set first and overwritten by either.
	for (const entry of promptEntries) {
		byToken.set(entry.token, entry);
	}
	for (const entry of builtInEntries) {
		byToken.set(entry.token, entry);
	}
	for (const entry of skillEntries) {
		byToken.set(entry.token, entry);
	}
	return {
		entries: Array.from(byToken.values()).toSorted((a, b) => b.token.length - a.token.length),
		byToken,
	};
}

function normalizeToken(raw: string): string {
	const t = raw.trim().toLowerCase();
	return t.startsWith("/") ? t : `/${t}`;
}

function parseInputToken(input: string): string | null {
	const trimmed = input.trim();
	if (!trimmed.startsWith("/")) return null;
	const token = trimmed.split(/\s+/)[0];
	return token.length > 1 ? normalizeToken(token) : null;
}

function parseInputArgs(input: string): string[] {
	const trimmed = input.trim();
	if (!trimmed.startsWith("/")) return [];
	const parts = trimmed.slice(1).split(/\s+/);
	return parts.slice(1);
}

function buildBuiltInEntries(): SlashRegistryEntry[] {
	const out: SlashRegistryEntry[] = [];
	for (const cmd of BUILT_IN_SLASH_COMMANDS) {
		const canonical = normalizeToken(cmd.name);
		out.push({
			token: canonical,
			name: cmd.name,
			canonicalName: cmd.name,
			description: cmd.description,
			usage: cmd.usage,
			kind: "builtin",
			builtInName: cmd.name,
		});
		for (const alias of cmd.aliases) {
			const token = normalizeToken(alias);
			out.push({
				token,
				name: token.slice(1),
				canonicalName: cmd.name,
				description: cmd.description,
				usage: cmd.usage,
				kind: "builtin",
				builtInName: cmd.name,
			});
		}
	}
	return out;
}

async function buildSkillEntries(): Promise<SlashRegistryEntry[]> {
	const skillManager = getSkillManager();
	await skillManager.loadSkills();
	const out: SlashRegistryEntry[] = [];
	for (const token of skillManager.getSkillSlashTriggers()) {
		const normalized = normalizeToken(token);
		const skill = skillManager.getSkill(normalized.slice(1));
		if (!skill) continue;
		out.push({
			token: normalized,
			name: normalized.slice(1),
			canonicalName: skill.name,
			description: skill.description || "Loaded skill",
			kind: "skill",
			skillName: skill.name,
		});
	}
	return out;
}

/**
 * Prompt templates (#3918 G4): each ~/.8gent/prompts/<name>.md is /name in
 * the menu. Typing it sends the file's text with $1, $@ filled in
 * (packages/extensions/prompts.ts, prompt-slash.ts). No home directory, or an
 * unreadable folder, means no entries rather than a failed menu.
 */
export function buildPromptEntries(
	templates: ReturnType<typeof loadPromptTemplates> = safeLoadTemplates(),
): SlashRegistryEntry[] {
	return templates.map((t) => ({
		token: normalizeToken(t.name),
		name: t.name,
		canonicalName: t.name,
		description: t.description || "Prompt template",
		usage: `/${t.name} [arguments]`,
		kind: "prompt",
		templateFile: t.file,
	}));
}

function safeLoadTemplates(): ReturnType<typeof loadPromptTemplates> {
	try {
		return loadPromptTemplates();
	} catch {
		return [];
	}
}

export function getBuiltInSlashCommands(): BuiltInSlashCommandDef[] {
	return BUILT_IN_SLASH_COMMANDS;
}

export async function getSlashRegistry(): Promise<SlashRegistry> {
	return mergeSlashEntries(buildBuiltInEntries(), await buildSkillEntries(), buildPromptEntries());
}

export function resolveSlashInput(
	input: string,
	registry: SlashRegistry,
): ResolvedSlashInput | null {
	const token = parseInputToken(input);
	if (!token) return null;
	const entry = registry.byToken.get(token);
	if (!entry) return null;
	return { entry, args: parseInputArgs(input) };
}

export function toGhostSuggestions(registry: SlashRegistry): {
	trigger: string;
	suggestion: string;
	confidence: number;
}[] {
	return registry.entries.map((e) => ({
		trigger: e.token,
		suggestion: "",
		confidence: 0.88,
	}));
}

export function getSkillSummary(registry: SlashRegistry): {
	name: string;
	description: string;
}[] {
	const byName = new Map<string, { name: string; description: string }>();
	for (const e of registry.entries) {
		if (e.kind !== "skill") continue;
		if (!byName.has(e.canonicalName)) {
			byName.set(e.canonicalName, {
				name: e.canonicalName,
				description: e.description,
			});
		}
	}
	return Array.from(byName.values()).toSorted((a, b) => a.name.localeCompare(b.name));
}
