/**
 * Efficiency rules appended to a pool child's task (#3784).
 *
 * Parent plus three children share one local model, so every child step costs
 * several single-session steps. In pilot run 2026-10-08_211356 the 8TO child
 * read one file three times and ran `mkdir -p notes` twice, and the run ended
 * before it wrote its note, the last thing it did. The rules cost a few lines
 * of prompt and remove the steps that were measured as waste.
 */

export const CHILD_GUIDANCE_MARKER = "[Efficiency rules for this task]";

const GUIDANCE = `${CHILD_GUIDANCE_MARKER}
- Each step is slow because other agents share the model. Do not spend a step you do not need.
- Read a file once. Do not read a file again after you have read or written it; use what you already have.
- Do not repeat a command that already succeeded (for example mkdir): run it once.
- If the task asks for a note or other output file, write it right after your edit, before you run tests or verify. Update it afterwards only if verification changes what it says.`;

/** The task with the efficiency rules after it. Idempotent. */
export function withChildGuidance(task: string): string {
	return task.includes(CHILD_GUIDANCE_MARKER) ? task : `${task}\n\n${GUIDANCE}`;
}
