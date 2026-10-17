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
 *   - a working directory, absolute; not win32 (the grammar below is POSIX);
 *   - the whole command is plain words (no quote, glob, `$`, backtick, `~`,
 *     redirect, pipe, `;`, `&`, `:`, `@`, newline), no prompt-control text, and
 *     decideRules fired no rule;
 *   - exactly `8gent deck render <spec> [out]`: no flags, no env prefix, no
 *     other binary name (`bun bin/8gent.ts` is not this lane);
 *   - the `8gent` that will run is the installed one, not the workspace's
 *     (8SO review of #4084): every PATH entry is absolute and resolves outside
 *     the workspace; `8gent` is found on PATH as an executable regular file
 *     whose real location is outside the workspace; when it is a script or a
 *     shim (shebang, .js/.mjs/.cjs/.sh/.ts) its entry script resolves outside
 *     the workspace too: the npm launcher's `../dist/cli.js`, and every
 *     path-like token in the first 64 KB of the file, absolute or relative to
 *     the file's directory; and the workspace holds no `8gent`, `bin/8gent.ts`,
 *     `bin/8gent-run.js` or `dist/cli.js` of its own (a source checkout or a
 *     planted binary is the judge's call);
 *   - the spec is a relative `.json` path with no `..`/`.`/`.git`/empty segment
 *     and no dot-leading segment other than a leading `.tmp`, names a regular
 *     file (not a symlink) whose real location is inside the workspace;
 *   - the output, when given, is a relative `.mp4` path under the same rules,
 *     resolves inside the workspace (not the root itself), has no symlink in
 *     its existing ancestors, is absent or a regular file, and is not under a
 *     protected prefix or a protected name.
 *
 * After a `cd <folder> &&` (#3199) the cwd is that folder, but the project
 * around it is workspace too (8SO, #4169): the PATH, the installed `8gent`, its
 * entry scripts and the planted-checkout names are checked against the project
 * root as well as the cwd. The spec and output stay confined to the cwd.
 *
 * The CLI re-checks every path with the tool's own confinement, so this lane
 * only decides who gets asked; it never widens what the renderer may write.
 *
 * Known window, same as s1-mv-in-project.ts: a process of this uid could swap a
 * file for a symlink between this check and the spawn.
 *
 * Synchronous, never throws.
 */

import { constants, accessSync, closeSync, openSync, readSync, readlinkSync } from "node:fs";
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
// The 8.3-expanding realpath: a root and a PATH entry must be spelt the same way to compare
// (RUNNER~1 vs runneradmin on Windows), or a PATH entry inside the workspace reads as outside it.
import { realpathSync } from "./s1-run-in-project";

const PLAIN = /^[A-Za-z0-9._/+,= -]+$/;
/** Files whose presence makes the workspace look like an 8gent checkout or a planted binary. */
const WORKSPACE_8GENT = ["8gent", "bin/8gent.ts", "bin/8gent-run.js", "dist/cli.js"];
const SCRIPT_EXT = /\.(?:m?js|cjs|sh|ts)$/i;
const SCAN_BYTES = 64 * 1024;
/** Path-like tokens in a script: absolute, or relative to the script's directory. */
const PATH_TOKEN = /(?:\/|\.{1,2}\/)[^\s"'`;)(,]+/g;

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

/** The first SCAN_BYTES of a file as latin1 text, or null. */
function head(file: string): string | null {
	let fd: number | undefined;
	try {
		fd = openSync(file, "r");
		const buf = Buffer.alloc(SCAN_BYTES);
		const n = readSync(fd, buf, 0, SCAN_BYTES, 0);
		return buf.toString("latin1", 0, n);
	} catch {
		return null;
	} finally {
		if (fd !== undefined) closeSync(fd);
	}
}

/**
 * The real location of `p` when it exists, else the real location of its nearest existing ancestor.
 * A dangling symlink on the way is followed to where it points (8SO review of #4171): a link from
 * outside to a folder not yet made in the workspace names a workspace path. null when a link chain
 * never resolves (a loop); callers treat that as inside.
 */
function realOrAncestor(p: string, depth = 0): string | null {
	let cur = p;
	let rest = "";
	for (let i = 0; i < 64 && cur !== path.dirname(cur); i++) {
		try {
			return path.join(realpathSync(cur), rest);
		} catch {
			if (lstatOrNull(cur)?.isSymbolicLink()) {
				if (depth >= 8) return null;
				const target = path.resolve(path.dirname(cur), readlinkSync(cur));
				return realOrAncestor(path.join(target, rest), depth + 1);
			}
			rest = path.join(path.basename(cur), rest);
			cur = path.dirname(cur);
		}
	}
	return p;
}

/**
 * True when every PATH entry is absolute and resolves outside the workspace (8SO review of #4084):
 * no `.`, no empty entry, nothing a command could find inside the workspace. Shared with
 * s1-tg-send.ts (#4101), whose sh and curl are found on the same PATH.
 */
export function pathOutsideWorkspace(root: string, pathEnv: string): boolean {
	const entries = pathEnv.split(path.delimiter);
	if (entries.length === 0) return false;
	for (const dir of entries) {
		if (!dir || !path.isAbsolute(dir)) return false;
		const real = realOrAncestor(dir);
		if (real === null || inside(real, root)) return false;
	}
	return true;
}

/**
 * True only when `8gent` on an all-absolute PATH is an executable regular file
 * outside every one of `roots` and nothing it runs resolves inside any of them.
 */
function installedOutside(roots: string[], pathEnv: string): boolean {
	if (roots.some((r) => !pathOutsideWorkspace(r, pathEnv))) return false;
	const within = (p: string) => roots.some((r) => inside(p, r));
	const entries = pathEnv.split(path.delimiter);
	let bin: string | null = null;
	for (const dir of entries) {
		const cand = path.join(dir, "8gent");
		const st = lstatOrNull(cand);
		if (!st) continue;
		try {
			const real = realpathSync(cand);
			accessSync(real, constants.X_OK);
			const rst = lstatOrNull(real);
			if (!rst?.isFile()) return false;
			bin = real;
		} catch {
			return false;
		}
		break;
	}
	if (!bin || within(bin)) return false;
	const dir = path.dirname(bin);
	const text = head(bin);
	if (text === null) return false;
	const script = text.startsWith("#!") || SCRIPT_EXT.test(bin);
	if (!script) return true; // a compiled binary: nothing further to follow
	const entries2 = [path.join(dir, "..", "dist", "cli.js")];
	for (const m of text.match(PATH_TOKEN) ?? []) {
		entries2.push(path.isAbsolute(m) ? m : path.resolve(dir, m));
	}
	for (const e of entries2) {
		const real = realOrAncestor(e);
		if (real === null || within(real)) return false;
	}
	return true;
}

export function deckRenderInProject(
	command: string,
	cwd: string | undefined,
	env: Record<string, string | undefined> = process.env,
	/** The project root when `cwd` is a folder a `cd <folder> &&` chose inside it (#3199, #4169). */
	project?: string,
): DeckRender {
	try {
		if (process.platform === "win32") return NO;
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
		const roots = project === undefined ? [root] : [root, realpathSync(project)];
		// The `8gent` that runs must be the installed one, not something in the workspace.
		for (const r of roots)
			for (const rel of WORKSPACE_8GENT) if (lstatOrNull(path.join(r, rel))) return NO;
		if (!installedOutside(roots, env.PATH ?? process.env.PATH ?? "")) return NO;

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
