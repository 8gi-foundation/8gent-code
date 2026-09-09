// Cross-workspace import of a package's public entrypoint (packages/*/index.ts).
// These are the canonical surface for inter-package use; deep imports would
// bypass each package's documented API. Suppressed by design.
// react-doctor-disable-next-line react-doctor/no-barrel-import
import { getSkillManager, parseSkillCommand } from "../../../../packages/skills/index.js";
import { SKILL_NAMESPACE_PREFIX } from "./slash-registry.js";

/** `/skill:voice` names the skill explicitly when a builtin owns `/voice` (#2932). */
export function stripSkillNamespace(name: string): string {
	return name.toLowerCase().startsWith(SKILL_NAMESPACE_PREFIX)
		? name.slice(SKILL_NAMESPACE_PREFIX.length)
		: name;
}

/**
 * If input is `/skillname ...` (or `/skill:skillname ...`) and matches a loaded skill,
 * expand to the skill prompt (same behavior as packages/eight/repl handleSkillInvocation).
 * Unknown slashes pass through.
 */
export async function expandSkillSlashCommand(message: string): Promise<string> {
	const t = message.trim();
	if (!t.startsWith("/")) return message;
	const skillCmd = parseSkillCommand(t);
	if (!skillCmd) return message;
	try {
		const skillManager = getSkillManager();
		await skillManager.loadSkills();
		const skill = skillManager.getSkill(stripSkillNamespace(skillCmd.name));
		if (!skill) return message;
		let fullPrompt = `[SKILL: ${skill.name}]\n\n${skill.prompt}`;
		if (Object.keys(skillCmd.args).length > 0) {
			fullPrompt += `\n\n## Arguments\n${JSON.stringify(skillCmd.args, null, 2)}`;
		}
		return fullPrompt;
	} catch {
		return message;
	}
}
