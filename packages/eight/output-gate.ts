/**
 * 8gent - Required-output gate (issue #4734).
 *
 * Evidence run 2026-10-22_101207 (sigi-dev-arc1-a): the ask named answer.json, the model
 * ended its turn at step 18 of a 1500 s budget with prose only, and the file never existed.
 * Nothing in the loop stops a turn from ending without the output the ask named.
 *
 * This gate does. Output paths are read from the first user message of the turn (a token
 * ending in a known extension, or the token after "write", "save to", "output:", "create").
 * Paths that already exist at turn start are not required. A text-only turn end while a
 * required path is still missing gets a nudge, at most MAX_NUDGES per turn; a one-line
 * reply after a nudge counts as "why it cannot be written" and ends the turn. Past the
 * limit the turn ends with the missing list appended to the final text.
 *
 *   - Off by default. On with EIGHT_OUTPUT_GATE=1 (or "true") or the outputGate: true option.
 *   - Pure but for existsSync. agent.ts owns one instance per turn and the two turn-end seams.
 */

import { existsSync } from "node:fs";
import { isAbsolute, relative, resolve } from "node:path";

export const MAX_OUTPUT_NUDGES = 2;

const EXT = "(?:json|md|py|ts|txt|csv|ya?ml|html)";
const BY_EXT = new RegExp(`^[^\\s"'\`<>()]*\\.${EXT}$`, "i");
const AFTER_KEYWORD =
	/(?:\bwrite(?:\s+(?:it|this|the\s+\w+))?(?:\s+to)?|\bsave\s+to|\boutput:|\bcreate)\s+["'`]?([^\s"'`<>()]+)/gi;

export function isOutputGateEnabled(
	env: Record<string, string | undefined> = process.env,
	option?: boolean,
): boolean {
	if (option !== undefined) return option;
	const v = (env.EIGHT_OUTPUT_GATE ?? "").trim().toLowerCase();
	return v === "1" || v === "true";
}

export function outputNudge(path: string): string {
	return `Required output ${path} does not exist yet. Write it, or say in one line why it cannot be written.`;
}

const clean = (t: string) => t.replace(/^["'`([]+|["'`.,;:)\]]+$/g, "");

/** Output paths the ask names, as they were written, in order, deduplicated. */
export function namedOutputs(task: string): string[] {
	const found: string[] = [];
	for (const raw of task.split(/\s+/)) {
		const t = clean(raw);
		if (t && !t.includes("://") && BY_EXT.test(t)) found.push(t);
	}
	for (const m of task.matchAll(AFTER_KEYWORD)) {
		const t = clean(m[1] ?? "");
		if (t && !t.includes("://") && /[./]/.test(t) && !/^\d/.test(t)) found.push(t);
	}
	return [...new Set(found)];
}

export class OutputGate {
	private nudges = 0;
	private readonly required: { shown: string; abs: string }[];
	readonly events: {
		event: "output_gate";
		action: "nudge" | "explained" | "exhausted";
		missing: string[];
	}[] = [];

	constructor(
		task: string,
		private readonly cwd: string,
		enabled: boolean,
	) {
		this.required = !enabled
			? []
			: namedOutputs(task)
					.map((shown) => ({ shown, abs: resolve(cwd, shown) }))
					.filter(
						({ abs }) => !relative(cwd, abs).startsWith("..") && !isAbsolute(relative(cwd, abs)),
					)
					.filter(({ abs }) => !existsSync(abs));
	}

	missing(): string[] {
		return this.required.filter(({ abs }) => !existsSync(abs)).map(({ shown }) => shown);
	}

	/** The nudge for a text-only turn end, or null when the turn may end. */
	check(reply: string): string | null {
		const missing = this.missing();
		if (missing.length === 0 || this.nudges >= MAX_OUTPUT_NUDGES) return null;
		const oneLine = reply.trim() !== "" && !reply.trim().includes("\n");
		if (this.nudges > 0 && oneLine) {
			this.events.push({ event: "output_gate", action: "explained", missing });
			return null;
		}
		this.nudges++;
		this.events.push({ event: "output_gate", action: "nudge", missing });
		return outputNudge(missing[0]);
	}

	/** The final text with the missing list appended when the nudges ran out unanswered. */
	settle(reply: string): string {
		const missing = this.missing();
		if (missing.length === 0 || this.nudges < MAX_OUTPUT_NUDGES) return reply;
		if (this.events.at(-1)?.action === "explained") return reply;
		this.events.push({ event: "output_gate", action: "exhausted", missing });
		return `${reply.trimEnd()}\n\n[output-gate] Required output still missing: ${missing.join(", ")}`;
	}
}
