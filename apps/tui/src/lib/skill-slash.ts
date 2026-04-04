import {
	getSkillManager,
	parseSkillCommand,
} from "../../../../packages/skills/index.js";

/**
 * If input is `/skillname ...` and matches a loaded skill, expand to the skill prompt
 * (same behavior as packages/eight/repl handleSkillInvocation). Unknown slashes pass through.
 */
export async function expandSkillSlashCommand(
	message: string,
): Promise<string> {
	const t = message.trim();
	if (!t.startsWith("/")) return message;
	const skillCmd = parseSkillCommand(t);
	if (!skillCmd) return message;
	try {
		const skillManager = getSkillManager();
		await skillManager.loadSkills();
		const skill = skillManager.getSkill(skillCmd.name);
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
