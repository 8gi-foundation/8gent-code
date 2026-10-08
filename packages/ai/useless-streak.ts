/**
 * Answer-only after a streak of useless tool results (#3613).
 *
 * A small model on a dead end keeps calling tools that return nothing: a
 * search source is down, a path is wrong. The loop detector catches the SAME
 * call repeated and two-tool ping-pong, not different calls that all come back
 * empty, so the turn burns rounds until a cap. Paper (arXiv 2610.06191): agents
 * judge such results useless almost every time yet rarely stop; prompting does
 * not fix it, removing the tools does.
 *
 * Rule: after N useless results in a row, the next model turn gets a harness
 * note ("answer now with what you have") and no tools.
 *
 * Flag: EIGHT_USELESS_STREAK. Off by default.
 *   - unset, "0", "false", "off": off
 *   - "1" or "true": on, threshold DEFAULT_USELESS_STREAK (5, as in the paper)
 *   - an integer N >= 2: on, threshold N
 *
 * Useless is judged from the harness side only, never from what the output
 * says about itself: empty output, an executor "Error..." result, or an
 * identical call returning the identical result as before (no progress).
 * A gate refusal ("[BLOCKED]") is not counted and does not reset the streak:
 * the loop detector and the blocked-call checks own refusals.
 */
import { isRefusedToolResult } from "./claim-check";

export const DEFAULT_USELESS_STREAK = 5;

/** Threshold from EIGHT_USELESS_STREAK; 0 means off. */
export function resolveUselessStreak(env: Record<string, string | undefined> = process.env): number {
	const v = (env.EIGHT_USELESS_STREAK ?? "").trim().toLowerCase();
	if (v === "1" || v === "true" || v === "on") return DEFAULT_USELESS_STREAK;
	const n = Number(v);
	return Number.isInteger(n) && n >= 2 ? n : 0;
}

const isGateBlock = (result: string) => /^\s*\[[^\]\n]*\bBLOCKED\b[^\]\n]*\]/i.test(result);

/** Empty output or an executor error. A gate refusal is not useless here. */
export function isUselessResult(result: string): boolean {
	if (result.trim() === "") return true;
	return isRefusedToolResult(result) && !isGateBlock(result);
}

/** The note sent in place of the tool protocol once the streak trips. */
export function uselessStreakNote(count: number, tried: string[]): string {
	return [
		`[harness] Stop searching: your last ${count} tool calls returned nothing useful (empty, error, or the same result again).`,
		`Tried: ${tried.join(", ")}. Tools are not available for this reply.`,
		"Answer now with what you have. Say plainly what you could not find.",
	].join("\n");
}

export class UselessStreak {
	count = 0;
	private tried: string[] = [];
	private seen = new Map<string, string>();

	constructor(private readonly threshold: number) {}

	record(name: string, args: Record<string, unknown>, result: string): void {
		if (isGateBlock(result)) return;
		const key = `${name}:${JSON.stringify(args)}`;
		const noProgress = this.seen.get(key) === result;
		this.seen.set(key, result);
		if (isUselessResult(result) || noProgress) {
			this.count++;
			if (!this.tried.includes(name)) this.tried.push(name);
		} else {
			this.count = 0;
			this.tried = [];
		}
	}

	tripped(): boolean {
		return this.threshold > 0 && this.count >= this.threshold;
	}

	note(): string {
		return uselessStreakNote(this.count, this.tried);
	}
}
