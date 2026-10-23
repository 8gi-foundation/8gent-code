/**
 * Stop and report after a run of tool calls with nothing said (#4791).
 *
 * A phone session asked "why the slash ain't working" ran 38 tool calls in a
 * row, each round carrying no prose, until the 1200 s turn budget ended it with
 * no answer. The person saw a spinner for 20 minutes. The useless-streak guard
 * (useless-streak.ts) only counts calls that returned nothing; these calls all
 * returned something, so it never fired, and the loop detector only catches
 * repeats.
 *
 * Rule: after N tool calls with no prose to the person in between, the next
 * model turn gets a harness note and no tools, and its reply ends the turn. The
 * reply is the progress line, and the question asks whether to keep going.
 *
 * Flag: EIGHT_SILENT_CALLS. On by default at DEFAULT_SILENT_CALLS.
 *   - unset: DEFAULT_SILENT_CALLS
 *   - "0", "false", "off": off
 *   - an integer N >= 2: threshold N
 *
 * A round's prose counts as "said something" only past MIN_PROSE_CHARS, so a
 * bare "Let me check." does not reset the count.
 */

export const DEFAULT_SILENT_CALLS = 8;
export const MIN_PROSE_CHARS = 40;

/** Threshold from EIGHT_SILENT_CALLS; 0 means off. */
export function resolveSilentCalls(env: Record<string, string | undefined> = process.env): number {
	const v = (env.EIGHT_SILENT_CALLS ?? "").trim().toLowerCase();
	if (v === "") return DEFAULT_SILENT_CALLS;
	const n = Number(v);
	return Number.isInteger(n) && n >= 2 ? n : 0;
}

/** The note sent in place of the tool protocol once the count trips. */
export function silentCallsNote(count: number, tried: string[]): string {
	return [
		`[harness] You have run ${count} tool calls in a row without telling the person anything.`,
		`Tools used: ${tried.join(", ")}. Tools are not available for this reply.`,
		"In two or three plain sentences say what you have found so far, then ask whether to keep going.",
	].join("\n");
}

export class SilentCalls {
	count = 0;
	private tried: string[] = [];

	constructor(private readonly threshold: number) {}

	/** One finished round: its prose, and the names of the work calls it ran. */
	round(prose: string, calls: string[]): void {
		if (prose.trim().length >= MIN_PROSE_CHARS) {
			this.count = 0;
			this.tried = [];
		}
		this.count += calls.length;
		for (const c of calls) if (!this.tried.includes(c)) this.tried.push(c);
	}

	tripped(): boolean {
		return this.threshold > 0 && this.count >= this.threshold;
	}

	note(): string {
		return silentCallsNote(this.count, this.tried);
	}
}

/**
 * The same rule over the native loop's finished steps (prepareStep's `steps`):
 * the note when the run so far is `threshold` or more tool calls with no prose
 * between them, else null.
 */
export function silentCallsNoteForSteps(
	steps: ReadonlyArray<{ text?: string; toolCalls?: ReadonlyArray<{ toolName?: string }> }>,
	threshold: number,
): string | null {
	const silent = new SilentCalls(threshold);
	for (const s of steps) {
		silent.round(
			s.text ?? "",
			(s.toolCalls ?? []).map((c) => c.toolName ?? "tool"),
		);
	}
	return silent.tripped() ? silent.note() : null;
}
