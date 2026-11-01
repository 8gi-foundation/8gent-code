/**
 * Auto Skill Creator — lets 8gent author its own SKILL.md files.
 *
 * Exposed to the agent as the `propose_skill_creation` tool. The agent has
 * "free will" to call it when it judges a recurring or reusable pattern is
 * worth capturing. Hard caps + name guards + audit log provide the safety rail.
 *
 * Skills are written to `packages/skills/<name>/SKILL.md` so they ship to every
 * 8gent-code user, not just the local machine.
 *
 * Audit log at `~/.8gent/auto-created-skills.jsonl` — one line per creation
 * with timestamp, session id, file path, and an exact revert command.
 */

import * as fs from "node:fs";
import { homedir } from "node:os";
import * as path from "node:path";

// Hard cap so a runaway agent loop can't author 50 skills overnight.
export const MAX_AUTO_SKILLS_PER_SESSION = 3;

const REPO_ROOT = path.resolve(import.meta.dir, "..", "..");
const SKILLS_DIR = path.join(REPO_ROOT, "packages", "skills");
const LOG_FILE = path.join(homedir(), ".8gent", "auto-created-skills.jsonl");

let createdThisSession = 0;

export interface SkillSpec {
	/** kebab-case skill folder name */
	name: string;
	/** one-line description used in skill index + agent recall */
	description: string;
	/** body of SKILL.md after the frontmatter (title + sections) */
	body: string;
	/** optional rationale recorded in the audit log */
	rationale?: string;
}

export interface SkillCreationResult {
	ok: boolean;
	reason: string;
	name?: string;
	path?: string;
	revert?: string;
	creationsRemaining?: number;
}

/**
 * Author a SKILL.md file. Returns ok=false with a reason if blocked.
 * The agent reads the reason to learn whether to try again with different inputs.
 */
export function createAutoSkill(
	spec: SkillSpec,
	context: { sessionId: string },
): SkillCreationResult {
	if (createdThisSession >= MAX_AUTO_SKILLS_PER_SESSION) {
		return {
			ok: false,
			reason: `session-cap-reached (max ${MAX_AUTO_SKILLS_PER_SESSION})`,
		};
	}

	const safeName = sanitizeName(spec.name);
	if (!safeName) {
		return { ok: false, reason: "invalid-name" };
	}
	if (!spec.description || spec.description.trim().length < 10) {
		return { ok: false, reason: "description-too-short" };
	}
	if (!spec.body || spec.body.trim().length < 30) {
		return { ok: false, reason: "body-too-short" };
	}

	const targetDir = path.join(SKILLS_DIR, safeName);
	if (!targetDir.startsWith(SKILLS_DIR + path.sep) && targetDir !== SKILLS_DIR) {
		return { ok: false, reason: "path-traversal-blocked" };
	}
	if (fs.existsSync(targetDir)) {
		return { ok: false, reason: "name-collision" };
	}

	const frontmatter = [
		"---",
		`name: ${safeName}`,
		`description: ${escapeYamlScalar(spec.description.trim())}`,
		"source: auto-created",
		`created: ${new Date().toISOString()}`,
		"---",
		"",
	].join("\n");

	const content = `${frontmatter}${spec.body.trim()}\n`;

	try {
		fs.mkdirSync(targetDir, { recursive: true });
		fs.writeFileSync(path.join(targetDir, "SKILL.md"), content, "utf-8");
	} catch (err) {
		return { ok: false, reason: `write-failed: ${(err as Error).message}` };
	}

	const revert = `rm -rf "${targetDir}"`;
	const logEntry = {
		timestamp: new Date().toISOString(),
		sessionId: context.sessionId,
		name: safeName,
		path: path.join(targetDir, "SKILL.md"),
		description: spec.description,
		rationale: spec.rationale ?? null,
		revert,
	};
	appendLog(logEntry);

	createdThisSession += 1;

	return {
		ok: true,
		reason: "created",
		name: safeName,
		path: logEntry.path,
		revert,
		creationsRemaining: MAX_AUTO_SKILLS_PER_SESSION - createdThisSession,
	};
}

export function getSessionCreationCount(): number {
	return createdThisSession;
}

/** Test-only: reset the in-memory session counter. */
export function _resetForTests(): void {
	createdThisSession = 0;
}

function sanitizeName(raw: string): string {
	const cleaned = (raw || "")
		.toLowerCase()
		.replace(/[^a-z0-9-]+/g, "-")
		.replace(/^-+|-+$/g, "")
		.replace(/-{2,}/g, "-")
		.slice(0, 60);
	if (cleaned.length < 3) return "";
	return cleaned;
}

function escapeYamlScalar(s: string): string {
	if (/[:\n#"']/.test(s)) {
		return JSON.stringify(s);
	}
	return s;
}

function appendLog(entry: object): void {
	try {
		fs.mkdirSync(path.dirname(LOG_FILE), { recursive: true });
		fs.appendFileSync(LOG_FILE, `${JSON.stringify(entry)}\n`, "utf-8");
	} catch {
		// Audit log is best-effort. Never block the creation on log failure.
	}
}
