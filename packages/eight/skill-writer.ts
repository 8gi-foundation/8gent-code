/**
 * Skill document generator
 * Creates SKILL.md formatted docs from completed task data.
 * Vessel-authored (eight-1-q-14b), human-reviewed.
 */

export function writeSkillDoc(
  taskDescription: string,
  toolsUsed: string[],
  steps: string[],
): string {
  const name = taskDescription.slice(0, 60).replace(/[^a-zA-Z0-9 -]/g, "");
  const lines = [
    "---",
    `name: ${name}`,
    `description: ${taskDescription}`,
    "type: procedure",
    "---",
    "",
    `# ${name}`,
    "",
    taskDescription,
    "",
    "## Steps",
    "",
    ...steps.map((s, i) => `${i + 1}. ${s}`),
    "",
    "## Tools Used",
    "",
    ...toolsUsed.map((t) => `- \`${t}\``),
    "",
  ];
  return lines.join("\n");
}
