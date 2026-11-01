// Cross-workspace import of a package's public entrypoint (packages/*/index.ts).
// These are the canonical surface for inter-package use; deep imports would
// bypass each package's documented API. Suppressed by design.
// react-doctor-disable-next-line react-doctor/no-barrel-import
import {
	getSkillManager,
	parseSkillCommand,
	type SkillManager,
} from "../../../../packages/skills/index.js";

export type SkillSlashResolution =
	| { kind: "none" }
	| { kind: "skill"; name: string; prompt: string }
	| { kind: "unknown"; name: string; message: string };

const EXPLICIT = /^\/skill:(\S*)(?:\s+([\s\S]*))?$/;

/**
 * Resolve `/skill:name args` (explicit, Pi style) or `/name args` (implicit, only when a
 * skill by that name exists). Explicit with an unknown or empty name gives a clear
 * message listing what is available; implicit unknown slashes pass through as `none`.
 */
export async function resolveSkillSlash(
	message: string,
	manager: SkillManager = getSkillManager(),
): Promise<SkillSlashResolution> {
	const t = message.trim();
	if (!t.startsWith("/")) return { kind: "none" };

	const explicit = EXPLICIT.exec(t);
	const rewritten = explicit ? `/${explicit[1]}${explicit[2] ? ` ${explicit[2]}` : ""}` : t;
	const cmd = explicit && !explicit[1] ? null : parseSkillCommand(rewritten);
	if (!cmd) {
		return explicit
			? await unknown(manager, "", "Usage: /skill:<name> [args]")
			: { kind: "none" };
	}

	try {
		await manager.loadSkills();
		const skill = manager.getSkill(cmd.name);
		if (!skill) {
			return explicit ? await unknown(manager, cmd.name) : { kind: "none" };
		}
		let prompt = `[SKILL: ${skill.name}]\n\n${skill.prompt}`;
		if (Object.keys(cmd.args).length > 0) {
			prompt += `\n\n## Arguments\n${JSON.stringify(cmd.args, null, 2)}`;
		}
		return { kind: "skill", name: skill.name, prompt };
	} catch {
		return { kind: "none" };
	}
}

async function unknown(
	manager: SkillManager,
	name: string,
	lead?: string,
): Promise<SkillSlashResolution> {
	let names: string[] = [];
	try {
		await manager.loadSkills();
		names = manager
			.getAllSkills()
			.map((s) => s.name)
			.sort();
	} catch {
		// listing is best effort
	}
	const head = lead ?? `Unknown skill "${name}".`;
	const tail = names.length > 0 ? ` Available skills: ${names.join(", ")}.` : " No skills are installed.";
	return { kind: "unknown", name, message: `${head}${tail}` };
}

/**
 * If input is `/skill:name ...` or `/skillname ...` and matches a loaded skill, expand to the
 * skill prompt (same behavior as packages/eight/repl handleSkillInvocation). Unknown implicit
 * slashes pass through; an unknown explicit `/skill:name` becomes an instruction to relay the clear
 * "Unknown skill" message. A host that can show system messages should call resolveSkillSlash
 * and show `message` itself (see the `unknown` kind) instead of spending a model turn.
 */
export async function expandSkillSlashCommand(
	message: string,
	manager?: SkillManager,
): Promise<string> {
	const r = await resolveSkillSlash(message, manager);
	if (r.kind === "skill") return r.prompt;
	if (r.kind === "unknown") {
		// app.tsx calls this at agent-run time, so the only channel to the user from here is the
		// model. Tell it to relay the message verbatim instead of guessing what was meant.
		return `The user typed "${message.trim()}" but that skill does not exist. Do not guess or run anything. Reply with exactly this message and nothing else:\n\n${r.message}`;
	}
	return message;
}
