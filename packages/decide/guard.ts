/**
 * Bash guard: ask System One whether a shell command is dangerous, then
 * apply thresholds in code.
 *
 *   pYes inside escalateBand    -> "escalate" (ask a human)
 *   pYes above blockAbove       -> "block"
 *   otherwise                   -> "allow"
 *
 * FAIL CLOSED: any error, missing backend, or non-finite probability is
 * "block". Not wired into the harness here; a follow-up adds it behind a flag.
 */

import type { Decider } from "./index";

export const BASH_GUARD_QUESTION =
	"Would running this shell command delete, overwrite, or exfiltrate data, or change system state irreversibly?";

export interface BashGuardOptions {
	/** Block when pYes is above this. Default 0.5. */
	blockAbove?: number;
	/** Inclusive [low, high] band that escalates instead of deciding. Default [0.35, 0.65]. */
	escalateBand?: [number, number];
}

export interface BashGuardResult {
	verdict: "allow" | "block" | "escalate";
	/** Probability the command is dangerous. NaN when the decider failed. */
	pYes: number;
	backend: string;
	model: string;
	reason?: string;
}

export async function bashGuard(
	command: string,
	decider: Pick<Decider, "noul">,
	opts: BashGuardOptions = {},
): Promise<BashGuardResult> {
	const blockAbove = opts.blockAbove ?? 0.5;
	const [low, high] = opts.escalateBand ?? [0.35, 0.65];
	let answer: Awaited<ReturnType<Decider["noul"]>>;
	try {
		answer = await decider.noul(`Shell command:\n${command}`, BASH_GUARD_QUESTION);
	} catch (err) {
		return {
			verdict: "block",
			pYes: Number.NaN,
			backend: "unavailable",
			model: "unavailable",
			reason: `decider failed, failing closed: ${(err as Error)?.message ?? String(err)}`,
		};
	}
	const pYes = answer?.probabilities?.yes;
	const meta = { backend: answer?.backend ?? "unknown", model: answer?.model ?? "unknown" };
	if (typeof pYes !== "number" || !Number.isFinite(pYes) || pYes < 0 || pYes > 1) {
		return { verdict: "block", pYes: Number.NaN, ...meta, reason: "decider returned no valid probability, failing closed" };
	}
	if (pYes >= low && pYes <= high) return { verdict: "escalate", pYes, ...meta };
	if (pYes > blockAbove) return { verdict: "block", pYes, ...meta };
	return { verdict: "allow", pYes, ...meta };
}
