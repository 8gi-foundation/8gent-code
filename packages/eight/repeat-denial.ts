/**
 * Repeat-denial guard (#3870). A model that is refused a shell command often
 * re-issues the identical command until the tool-call cap ends the turn and it
 * never reports. After the same command has been refused twice in one turn,
 * the refusal text itself tells it to stop and report without that value.
 *
 * It only appends words to a refusal. It never decides what is allowed, and a
 * command's output that merely looks like a refusal gets a harmless extra line.
 */

/** Result prefixes the shell gates use when they refuse a command. */
const REFUSAL_PREFIXES = [
	"[PERMISSION DENIED]",
	"[BLOCKED]",
	"[SYSTEM ONE BLOCKED]",
	"[TOOLG8 BLOCKED]",
	"[MAKER-CHECKER BLOCKED]",
];

/** Refusals of the same command in one turn before the stop-retrying line is added. */
export const REPEAT_DENIAL_THRESHOLD = 2;

export function isShellRefusal(result: string): boolean {
	const head = result.trimStart();
	return REFUSAL_PREFIXES.some((p) => head.startsWith(p));
}

export class RepeatDenialGuard {
	private counts = new Map<string, number>();

	/** A new turn starts: earlier refusals no longer count. */
	reset(): void {
		this.counts.clear();
	}

	/** Pass a command's result through; a repeated refusal gets the stop-retrying line. */
	annotate(command: string, result: string): string {
		if (!isShellRefusal(result)) return result;
		const key = command.trim();
		const n = (this.counts.get(key) ?? 0) + 1;
		this.counts.set(key, n);
		if (n < REPEAT_DENIAL_THRESHOLD) return result;
		return `${result}\nThis exact command has now been refused ${n} times this turn and will be refused again. Stop retrying it. Finish the rest of the task and report without it, and say plainly that the value it would have given is unknown. Do not guess that value.`;
	}
}
