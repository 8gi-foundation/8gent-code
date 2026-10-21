import {
	expandPromptCommand,
	loadPromptTemplates,
} from "../../../../packages/extensions/prompts.js";
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
 * The collision line as the first screen may show it: developer noise, so only
 * with DEBUG=1 (the same switch packages/eight uses). /help still lists them.
 */
export function slashCollisionNotice(
	collisions: SlashCollision[],
	env: Record<string, string | undefined> = process.env,
): string | null {
	return env.DEBUG === "1" ? formatSlashCollisionLine(collisions) : null;
}

/** True for a bare "/" (or "/" plus only whitespace): the user wants the command list. */
export function isBareSlash(input: string): boolean {
	return /^\s*\/\s*$/.test(input);
}

/**
 * One line naming every skill trigger that lost to a builtin, or null when
 * there is nothing to say. Shown once at startup so the user learns why
 * `/voice` runs the builtin and not their skill.
 */
export function formatSlashCollisionLine(collisions: SlashCollision[]): string | null {
	if (collisions.length === 0) return null;
	const parts = collisions.map(
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

/**
 * Who else can claim a slash line after the registry and built-ins miss it.
 * Both default to the same lookups the submit path uses (resolveSkillSlash,
 * expandPromptSlashCommand), read fresh at submit time.
 */
export interface SlashHandlerLookups {
	/** True when a skill by this name exists (skills loaded now, not at mount). */
	skillExists: (name: string) => Promise<boolean>;
	/** True when a prompt template matches the line (templates read now). */
	templateMatches: (line: string) => boolean;
}

const defaultLookups: SlashHandlerLookups = {
	async skillExists(name) {
		try {
			const manager = getSkillManager();
			await manager.loadSkills();
			return !!manager.getSkill(name);
		} catch {
			return false;
		}
	},
	templateMatches(line) {
		try {
			return expandPromptCommand(line, loadPromptTemplates()) !== null;
		} catch {
			return false;
		}
	},
};

/**
 * The local answer for a line that starts with "/" but nothing claims, or null
 * when something does. A line is unknown only if ALL fail: not in the registry
 * (which may be stale or still loading), not a built-in, not an explicit
 * `/skill:` form (resolveSkillSlash owns that and its "Unknown skill"
 * message), no skill of that name found by loading skills now, and no prompt
 * template matching, read fresh. A path-like line such as `/Users/x/file`
 * matches none of these and gets the local answer.
 */
export async function unknownSlashAnswer(
	input: string,
	registry: SlashRegistry,
	lookups: SlashHandlerLookups = defaultLookups,
): Promise<string | null> {
	const trimmed = input.trim();
	if (!trimmed.startsWith("/")) return null;
	if (isBareSlash(trimmed)) return null;
	const name = trimmed.split(/\s+/)[0];
	if (resolveSlashInput(trimmed, registry)) return null;
	if (resolveSlashInput(trimmed, mergeSlashEntries(buildBuiltInEntries(), [], []))) return null;
	if (/^\/skill:/.test(name)) return null;
	if (await lookups.skillExists(name.slice(1))) return null;
	if (lookups.templateMatches(trimmed)) return null;
	return `Unknown command ${name}. Type /help.`;
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
