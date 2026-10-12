/**
 * System One: `8gent deck render <spec.json> [out.mp4]` inside the workspace.
 *
 * Pilot media-brief-video (12 Oct 2026): the model composed its video with raw
 * ffmpeg in run_command instead of calling render_video_deck. The shell door to
 * the same renderer (packages/eight/deck-cli.ts) must run without a judge call,
 * or the path of least resistance stays bash. Same lane shape as
 * s1-clone-local.ts: a deterministic allow, checked before the judge, default
 * mode only.
 *
 * ok needs ALL of:
 *   - a working directory, absolute;
 *   - the whole command is plain words (no quote, glob, `$`, backtick, `~`,
 *     redirect, pipe, `;`, `&`, `:`, `@`, newline), no prompt-control text, and
 *     decideRules fired no rule;
 *   - exactly `8gent deck render <spec> [out]`: no flags, no env prefix, no
 *     other binary name (`bun bin/8gent.ts` is not this lane);
 *   - the spec is a relative `.json` path with no `..`/`.`/`.git`/empty segment
 *     and no dot-leading segment other than a leading `.tmp`, names a regular
 *     file (not a symlink) whose real location is inside the workspace;
 *   - the output, when given, is a relative `.mp4` path under the same rules,
 *     resolves inside the workspace (not the root itself), has no symlink in
 *     its existing ancestors, is absent or a regular file, and is not under a
 *     protected prefix or a protected name.
 *
 * The CLI re-checks every path with the tool's own confinement, so this lane
 * only decides who gets asked; it never widens what the renderer may write.
 *
 * Known window, same as s1-mv-in-project.ts: a process of this uid could swap a
 * file for a symlink between this check and the spawn.
 *
 * Synchronous, never throws.
 */

import { realpathSync } from "node:fs";
import * as path from "node:path";
import { promptControlText } from "../decide/guard";
import { decideRules } from "../decide/rules";
import {
	lstatOrNull,
	plainRelative,
	protectedName,
	protectedRel,
	stripDot,
} from "./s1-mv-in-project";
import { inside } from "./s1-rm-nothing";

const PLAIN = /^[A-Za-z0-9._/+,= -]+$/;

export type DeckRender = { ok: true; reason: string } | { ok: false };

const NO: DeckRender = { ok: false };

/** A plain relative operand whose only dot-leading segment, if any, is a leading `.tmp`. */
function plainOperand(p: string, ext: RegExp): boolean {
	if (!plainRelative(p) || p.endsWith("/") || !ext.test(p)) return false;
	const segs = p.split("/");
	return segs.every((s, i) => !s.startsWith(".") || (i === 0 && s === ".tmp"));
}

/** True when any EXISTING ancestor of `abs` below `root` is a symlink. */
function symlinkOnTheWay(abs: string, root: string): boolean {
	for (let cur = path.dirname(abs); cur !== root && cur.startsWith(root); cur = path.dirname(cur)) {
		const st = lstatOrNull(cur);
		if (st?.isSymbolicLink()) return true;
	}
	return false;
}

export function deckRenderInProject(command: string, cwd: string | undefined): DeckRender {
	try {
		if (!cwd || !path.isAbsolute(cwd)) return NO;
		const text = command.trim();
		if (!PLAIN.test(text) || promptControlText(text) !== null) return NO;
		const words = text.split(/ +/);
		if (words[0] !== "8gent" || words[1] !== "deck" || words[2] !== "render") return NO;
		if (decideRules(text).rules.length !== 0) return NO;
		const operands = words.slice(3);
		if (operands.length < 1 || operands.length > 2) return NO;
		if (operands.some((o) => o.startsWith("-"))) return NO;
		const [specArg, outArg] = operands.map(stripDot);
		if (!plainOperand(specArg, /\.json$/i)) return NO;

		const root = realpathSync(cwd);
		const specAbs = path.resolve(root, specArg);
		const st = lstatOrNull(specAbs);
		if (!st || st.isSymbolicLink() || !st.isFile()) return NO;
		if (symlinkOnTheWay(specAbs, root)) return NO;
		if (!inside(realpathSync(specAbs), root)) return NO;

		if (outArg !== undefined) {
			if (!plainOperand(outArg, /\.mp4$/i)) return NO;
			const outAbs = path.resolve(root, outArg);
			if (!inside(outAbs, root) || outAbs === root) return NO;
			if (symlinkOnTheWay(outAbs, root)) return NO;
			const existing = lstatOrNull(outAbs);
			if (existing && (existing.isSymbolicLink() || !existing.isFile())) return NO;
			if (protectedName(path.basename(outAbs), true)) return NO;
			if (protectedRel(path.relative(root, outAbs))) return NO;
		}
		return {
			ok: true,
			reason: "8gent deck render of a spec inside the workspace to an mp4 inside the workspace",
		};
	} catch {
		return NO;
	}
}
