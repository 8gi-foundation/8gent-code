import { loadPromptTemplates } from "../../../../packages/extensions/prompts.js";
// Cross-workspace import of a package's public entrypoint (packages/*/index.ts).
// These are the canonical surface for inter-package use; deep imports would
// bypass each package's documented API. Suppressed by design.
// react-doctor-disable-next-line react-doctor/no-barrel-import
import { getSkillManager } from "../../../../packages/skills/index.js";
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
	bundled?: boolean;
	/** A prompt template (#3918 G4): the Markdown file it expands to. */
	templateFile?: string;
}

/**
 * A skill trigger that matched a builtin token. Builtins always win (#2932);
 * the skill stays reachable under the namespaced token so nothing is lost.
 */
export interface SlashCollision {
	token: string;
	builtInName: SlashCommand;
	skillName: string;
	namespacedToken: string;
	/** The skill ships with 8gent. Only the user's own skills are worth a startup notice. */
	bundled?: boolean;
}

export interface SlashRegistry {
	entries: SlashRegistryEntry[];
	byToken: Map<string, SlashRegistryEntry>;
	collisions: SlashCollision[];
}

/** Prefix that namespaces a skill whose trigger collides with a builtin: `/skill:<name>`. */
export const SKILL_NAMESPACE_PREFIX = "skill:";

export function namespacedSkillToken(token: string): string {
	const bare = token.startsWith("/") ? token.slice(1) : token;
	return `/${SKILL_NAMESPACE_PREFIX}${bare}`;
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
	const collisions: SlashCollision[] = [];
	const collidedTokens = new Set<string>();
	for (const entry of builtInEntries) {
		byToken.set(entry.token, entry);
	}
	for (const entry of skillEntries) {
		const existing = byToken.get(entry.token);
		if (existing?.kind === "builtin" && existing.builtInName) {
			// Builtins always win. The skill is re-keyed under /skill:<name>
			// so it can still be invoked, and the collision is recorded for
			// the startup line and for /help.
			const namespacedToken = namespacedSkillToken(entry.token);
			// A skill's canonical name and its alias key can normalize to the
			// same token; record that collision once.
			if (!collidedTokens.has(entry.token)) {
				collidedTokens.add(entry.token);
				collisions.push({
					token: entry.token,
					builtInName: existing.builtInName,
					skillName: entry.skillName ?? entry.canonicalName,
					namespacedToken,
					bundled: entry.bundled,
				});
			}
			if (!byToken.has(namespacedToken)) {
				byToken.set(namespacedToken, {
					...entry,
					token: namespacedToken,
					name: namespacedToken.slice(1),
				});
			}
			continue;
		}
		byToken.set(entry.token, entry);
	}
	return {
		entries: Array.from(byToken.values()).toSorted((a, b) => b.token.length - a.token.length),
		byToken,
		collisions,
	};
}

/**
 * One line naming every skill trigger that lost to a builtin, or null when
 * there is nothing to say. Shown once at startup so the user learns why
 * `/voice` runs the builtin and not their skill.
 */
export function formatSlashCollisionLine(collisions: SlashCollision[]): string | null {
	// Bundled skills collide on every clean install; a new user has nothing to act on.
	const own = collisions.filter((c) => !c.bundled);
	if (own.length === 0) return null;
	const parts = own.map(
		(c) => `${c.token} is the builtin; skill ${c.skillName} is ${c.namespacedToken}`,
	);
	return `Slash command collision: ${parts.join("; ")}.`;
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
			bundled: skillManager.getSkillTier(skill.name) === "bundled",
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
