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

/** The refusal came from a checker that was not ready, so it may work later. */
const TRANSIENT =
	/safety judge was (?:unavailable|not ready)|judge gave no verdict|checker timed out|System One unavailable|safety checker is not available|still loading/i;
/** A person said no (or it was declined earlier in the session). */
const DECLINED = /\bdeclined\b/i;

export type RefusalKind = "transient" | "declined" | "policy";

export function refusalKind(result: string): RefusalKind {
	if (TRANSIENT.test(result)) return "transient";
	if (DECLINED.test(result)) return "declined";
	return "policy";
}

/**
 * The same command, whatever order or flavour of flags: the program plus the
 * path-like targets it names. `ffprobe -v error -of x file.mp4` and
 * `ffprobe -of y -v quiet file.mp4` share a key. With no path-like target the
 * key is the program plus every non-flag word.
 */
export function commandKey(command: string): string {
	const words = command
		.trim()
		.split(/\s+/)
		.map((w) => w.replace(/^["']|["']$/g, ""))
		.filter(Boolean);
	const program = (words[0] ?? "").split("/").pop() ?? "";
	const rest = words.slice(1).filter((w) => !w.startsWith("-"));
	const targets = rest.filter((w) => !w.includes("=") && /[./]/.test(w));
	const chosen = targets.length > 0 ? targets : rest;
	return `${program} ${[...new Set(chosen)].sort().join(" ")}`.trim();
}

export class RepeatDenialGuard {
	private counts = new Map<string, number>();

	/** A new turn starts: earlier refusals no longer count. */
	reset(): void {
		this.counts.clear();
	}

	/**
	 * Pass a command's result through; a repeated refusal gets the stop-retrying
	 * line. `canAsk`: a person is bound to this session, so the line points the
	 * model at them instead of at giving up.
	 */
	annotate(command: string, result: string, canAsk = false): string {
		if (!isShellRefusal(result)) return result;
		const key = commandKey(command);
		const n = (this.counts.get(key) ?? 0) + 1;
		this.counts.set(key, n);
		if (n < REPEAT_DENIAL_THRESHOLD) return result;
		const kind = refusalKind(result);
		const times = `This command (or one that only changes its flags) has now been refused ${n} times this turn.`;
		const ask = canAsk ? " If you still need it, ask the user to run it or approve it." : "";
		if (kind === "transient")
			return `${result}\n${times} The safety judge was not ready; this may work later. Do not keep retrying it now. Finish what you can and report it as unknown for now.${ask} Do not guess the value.`;
		if (kind === "declined")
			return `${result}\n${times} The user declined this. Do not retry it.${canAsk ? " Ask them if it is essential." : " Finish the rest of the task and report without it."} Say plainly that the value it would have given is unknown. Do not guess it.`;
		return `${result}\n${times} It is being refused this turn. Stop retrying it. Finish the rest of the task and report without it, and say plainly that the value it would have given is unknown.${ask} Do not guess that value.`;
	}
}
