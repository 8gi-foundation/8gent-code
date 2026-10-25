/**
 * The one question (#5037, slice 1). Scans, shows what was found, asks a single y/N that
 * defaults to No, and only on a yes brings it home. A person who is not there answers No:
 * the caller's `ask` resolves null (or false) when nobody can answer, and nothing is written.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { ingest } from "./ingest.js";
import { askedMarkerPath } from "./paths.js";
import { scanOtherTools, summarizeScan } from "./scan.js";

export interface BringItHomeDeps {
	home: string;
	/** Resolves true for yes, false for no, null when nobody answered. Default is always No. */
	ask(line: string, defaultYes: boolean): Promise<boolean | null>;
	say(line: string): void;
	env?: Record<string, string | undefined>;
}

export type BringItHomeOutcome =
	| "imported"
	| "declined"
	| "unanswered"
	| "nothing-found"
	| "already-asked";

/** True once a person has answered the first-run question (yes or no). */
export function wasAsked(home: string): boolean {
	try {
		return fs.existsSync(askedMarkerPath(home));
	} catch {
		return false;
	}
}

function markAsked(home: string, answer: "yes" | "no", at: string): void {
	try {
		const f = askedMarkerPath(home);
		fs.mkdirSync(path.dirname(f), { recursive: true });
		fs.writeFileSync(f, `${JSON.stringify({ answer, at })}\n`, { mode: 0o600 });
	} catch {
		// Not being able to remember the answer must never block the owner.
	}
}

/**
 * mode "first-run" asks once ever and says nothing when there is nothing to bring home.
 * mode "command" (/bring-it-home) always shows the result and asks again.
 */
export async function offerBringItHome(
	mode: "first-run" | "command",
	deps: BringItHomeDeps,
): Promise<BringItHomeOutcome> {
	if (mode === "first-run" && wasAsked(deps.home)) return "already-asked";
	const scan = scanOtherTools({ home: deps.home });
	if (scan.totalItems === 0) {
		if (mode === "command")
			deps.say(
				"Nothing from other tools was found on this machine, so there is nothing to bring home.",
			);
		return "nothing-found";
	}
	const commands = scan.tools.reduce((n, t) => n + t.counts.command, 0);
	const note =
		commands > 0 ? `\n  (${commands} commands are listed here but come home in a later step.)` : "";
	const line =
		`I found setups from other tools on this machine:\n${summarizeScan(scan)}${note}\n` +
		`Nothing has been copied or sent anywhere. Bring them into your 8gent, in ~/.8gent/imported? (y/N)`;
	const answer = await deps.ask(line, false);
	if (answer === null) return "unanswered";
	const at = new Date().toISOString();
	if (answer !== true) {
		if (mode === "first-run") markAsked(deps.home, "no", at);
		deps.say("Nothing was changed. Type /bring-it-home whenever you want to do this.");
		return "declined";
	}
	const result = ingest(scan, { consent: true, home: deps.home, env: deps.env });
	markAsked(deps.home, "yes", at);
	const needs = result.written.filter((w) => w.status === "needs-edit");
	const lines = [
		`Brought ${result.written.length} items home to ~/.8gent/imported. 8gent no longer reads ~/.claude or ~/.agents skills live.`,
	];
	if (result.coreWon.length > 0)
		lines.push(
			`${result.coreWon.length} skill(s) were left out because 8gent's own skill of that name wins: ${result.coreWon.map((c) => c.name).join(", ")}.`,
		);
	if (result.deduped.length > 0)
		lines.push(`${result.deduped.length} duplicate skill(s) were merged by name.`);
	for (const n of needs.slice(0, 5)) lines.push(`Needs your edit: ${n.name} ${n.reason}`);
	if (needs.length > 5) lines.push(`...and ${needs.length - 5} more need your edit.`);
	deps.say(lines.join("\n"));
	return "imported";
}
