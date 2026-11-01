/**
 * herdr-open.ts - open a /term preset in a herdr pane beside 8gent (#4765 follow-up).
 *
 * Used when node-pty cannot load (Termux: `8gent update` installs with
 * --ignore-scripts, so it is never built) and 8gent runs inside herdr. herdr
 * owns the terminal, so a split pane needs no node-pty at all. Verified
 * against `herdr pane split --help` and `herdr pane run --help` (0.9.3):
 *   herdr pane split --pane <id> --direction right --cwd <dir> --focus
 *     -> stdout {"result":{"pane":{"pane_id":"w1:p2",...}}}
 *   herdr pane run <pane> <command...>   sends the text and Enter to that pane's shell
 * Both go through execFile with argv arrays. The one string the pane's shell
 * reads is the preset's absolute path, single-quoted here; the path was resolved
 * outside the project folder (#4769) and herdr is found on a filtered PATH.
 */

import { isAbsolute } from "node:path";
import { cwd as processCwd } from "node:process";
import { PANE_ID, resolveHerdr, runHerdr } from "./herdr.js";
import type { Env } from "./herdr.js";

/** One POSIX shell word: single-quoted, so no byte of the path is interpreted. */
export function shellQuote(s: string): string {
	return `'${s.replace(/'/g, `'\\''`)}'`;
}

/** argv for the split: beside the calling pane, to the right, in the project folder. */
export function buildSplitArgs(selfPane: string | undefined, cwd: string): string[] {
	const target = selfPane && PANE_ID.test(selfPane) ? ["--pane", selfPane] : ["--current"];
	return ["pane", "split", ...target, "--direction", "right", "--cwd", cwd, "--focus"];
}

/** argv that starts `absolutePath` in the new pane. The path is the only shell-read text. */
export function buildRunArgs(paneId: string, absolutePath: string): string[] {
	return ["pane", "run", paneId, shellQuote(absolutePath)];
}

export function newPaneId(stdout: string): string | null {
	try {
		const id = (JSON.parse(stdout) as { result?: { pane?: { pane_id?: unknown } } })?.result?.pane
			?.pane_id;
		return typeof id === "string" && PANE_ID.test(id) ? id : null;
	} catch {
		return null;
	}
}

export type HerdrOpen = { ok: true; message: string } | { ok: false; reason: string };

/**
 * Open `command` (an absolute path, or null for a plain shell) in a pane beside
 * this one. `reason` is why it did not happen, for the caller to show.
 */
export async function openInHerdrPane(
	label: string,
	command: string | null,
	opts: { env?: Env; cwd?: string } = {},
): Promise<HerdrOpen> {
	const env = opts.env ?? process.env;
	const cwd = opts.cwd ?? processCwd();
	if (command && !isAbsolute(command))
		return { ok: false, reason: `${command} was not found outside this project` };
	if (env.HERDR_ENV !== "1") return { ok: false, reason: "not inside a herdr pane" };
	const bin = resolveHerdr(env.PATH ?? "", cwd);
	if (!bin) return { ok: false, reason: "herdr is not on PATH outside this project" };
	const split = await runHerdr(bin, buildSplitArgs(env.HERDR_PANE_ID, cwd), env);
	if (!split.ok) return { ok: false, reason: split.line };
	const pane = newPaneId(split.stdout);
	if (!pane) return { ok: false, reason: "herdr split answered without a pane id" };
	if (command) {
		const run = await runHerdr(bin, buildRunArgs(pane, command), env);
		if (!run.ok) return { ok: false, reason: run.line };
	}
	return {
		ok: true,
		message: `Opened ${label} in a herdr pane beside 8gent (${pane}). Read it with /herdr ${pane}.`,
	};
}
