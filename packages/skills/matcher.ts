/**
 * Skill Matcher — find relevant learned skills for a new task.
 *
 * Pure keyword overlap scoring. No embeddings, no database.
 * Reads the learned-skills directory and ranks by relevance.
 */

import { existsSync, readFileSync } from "fs";
import { listLearnedSkills } from "./compound.js";

interface MatchedSkill {
	name: string;
	description: string;
	filePath: string;
	score: number;
	successes: number;
}

/** Tokenize a string into lowercase keyword set. */
function tokenize(text: string): Set<string> {
	return new Set(
		text
			.toLowerCase()
			.replace(/[^a-z0-9\s-]/g, " ")
			.split(/\s+/)
			.filter((w) => w.length > 2),
	);
}

/**
 * Find learned skills relevant to the given task description.
 * Returns top matches sorted by score descending.
 */
export function matchSkills(
	taskDescription: string,
	limit: number = 3,
): MatchedSkill[] {
	const paths = listLearnedSkills();
	if (paths.length === 0) return [];

	const queryTokens = tokenize(taskDescription);
	if (queryTokens.size === 0) return [];

	const scored: MatchedSkill[] = [];

	for (const filePath of paths) {
		if (!existsSync(filePath)) continue;

		const content = readFileSync(filePath, "utf-8");

		// Extract frontmatter fields
		const nameMatch = content.match(/^name:\s*(.+)$/m);
		const descMatch = content.match(/^description:\s*(.+)$/m);
		const successMatch = content.match(/^successes:\s*(\d+)/m);

		const name = nameMatch?.[1]?.trim() ?? "";
		const description = descMatch?.[1]?.trim() ?? "";
		const successes = successMatch ? parseInt(successMatch[1], 10) : 1;

		// Score: keyword overlap between query and skill content
		const skillTokens = tokenize(`${name} ${description} ${content}`);
		let overlap = 0;
		for (const token of queryTokens) {
			if (skillTokens.has(token)) overlap++;
		}

		if (overlap === 0) continue;

		// Normalize by query size, boost by success count (log scale)
		const base = overlap / queryTokens.size;
		const confidenceBoost = 1 + Math.log2(Math.max(1, successes)) * 0.1;
		const score = base * confidenceBoost;

		scored.push({ name, description, filePath, score, successes });
	}

	return scored.sort((a, b) => b.score - a.score).slice(0, limit);
}

/**
 * Format matched skills as a context block for injection into the agent prompt.
 * Returns empty string if no matches found.
 */
export function formatMatchedSkills(
	taskDescription: string,
	limit: number = 3,
): string {
	const matches = matchSkills(taskDescription, limit);
	if (matches.length === 0) return "";

	const lines = matches.map(
		(m) => `- **${m.name}** (${m.successes}x): ${m.description}`,
	);

	return `[Learned Skills]\n${lines.join("\n")}\n[/Learned Skills]`;
}
