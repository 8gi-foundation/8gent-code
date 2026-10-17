/**
 * System One: the login-note recipe, one labelled line of a workspace file
 * copied into .tmp/ (#4072).
 *
 * Pilot browser-op-practice (12 Oct 2026, run 172356): the model ran exactly
 * what LOCAL_LOGIN_NOTE prescribes, `sed -n 's/^Password: *\/password=/w
 * .tmp/login' TASK.txt`. No lane read it, the judge saw "Password" and scored
 * it pYes 0.48 (block); the same command again hit the memo, 0.48 again; an awk
 * variant 0.66. Zero sign-ins. A recipe the prompt itself prescribes must not
 * depend on a stochastic judge. This lane reads the command instead. Same
 * design as s1-curl-loopback.ts (#3941): an ALLOWLIST of one exact shape, never
 * a deny-list. Anything else is "no opinion" and the command goes to the rules
 * and the judge as before. The gate calls this only in System One's default
 * mode.
 *
 * `loginLineToTmp` answers ok only when ALL hold:
 *   - the whole command is `sed -n 's/^LABEL: *\/FIELD=/w .tmp/NAME' FILE` with
 *     exactly that spelling: `-n` (print nothing), one single-quoted script,
 *     one file operand, nothing else. LABEL is letters, digits, space, `_`, `-`
 *     (1 to 32); FIELD is a lowercase form field name (1 to 32); NAME is one
 *     plain file name (no `/`); FILE is a plain relative path. No `p` flag
 *     (that would print the value into the transcript), no `g`, `e` or `i`
 *     flag, no second expression, no `-i`, `-E`, `-e`, `-f`, no quotes other
 *     than the one pair, no `$`, backtick, `;`, `&`, `|`, `>`, `<`;
 *   - decideRules fires nothing and there is no prompt-control text;
 *   - FILE, after realpath of its nearest existing part, is a regular file
 *     inside the workspace: not a secret name (a basename ending in .env
 *     included, 8SO), not a protected path, no dot directory, no symlink
 *     anywhere below the workspace root;
 *   - .tmp/NAME is under the workspace's real `.tmp/` directory (absent is
 *     fine), NAME is not a script, template or config name (WRITE_BAD_NAME),
 *     not a secret name, and no component under .tmp is a symlink.
 *
 * What the command then does: reads FILE, writes the one matching line,
 * relabelled as the form field, into .tmp/NAME, prints nothing. No network, no
 * spawn, no env read (sed has no config file). A read_file of .tmp/NAME still
 * scrubs (the label is what the redactor matches on), and the only way the
 * line leaves the box is `curl -d @.tmp/NAME` through s1-curl-loopback.ts,
 * which sends to loopback only.
 *
 * Known limits, on purpose: BSD and GNU sed both accept this form; TOCTOU (out
 * of scope, accepted by 8SO for the sibling lanes): a path can be swapped for
 * a symlink between this check and the spawn.
 *
 * Synchronous, never throws.
 */

import { lstatSync } from "node:fs";
import * as path from "node:path";
import { promptControlText } from "../decide/guard";
import { decideRules } from "../decide/rules";
import { protectedRel, relSegments } from "./s1-mv-in-project";
import { inside } from "./s1-rm-nothing";
import { SECRET, WRITE_BAD_NAME, canon, realpathSync, symlinkBelow } from "./s1-run-in-project";

export type LoginLine = { ok: true; reason: string } | { ok: false };

/** Any file whose name ends in .env is a dotenv, whatever precedes the dot. */
const DOTENV_NAME = /\.env$/i;
const NO: LoginLine = { ok: false };

/** The one shape. Groups: label, field, output under .tmp/, input file. */
const SHAPE =
	/^sed -n 's\/\^([A-Za-z][A-Za-z0-9 _-]{0,31}): \*\/([a-z][a-z0-9_-]{0,31})=\/w (\.tmp\/[A-Za-z0-9][A-Za-z0-9._-]{0,63})' ([A-Za-z0-9][A-Za-z0-9._/-]{0,199})$/;

/** A workspace-relative path as the reason shows it: slash-separated on every platform. */
const slash = (rel: string): string => rel.split(path.sep).join("/");

/** The workspace-relative path of `p` under `root`, resolved, or null when it leaves the workspace. */
function relInside(p: string, root: string): { abs: string; rel: string; lexical: string } | null {
	if (p.split("/").includes("..")) return null;
	const lexical = path.resolve(root, p);
	const abs = canon(lexical);
	if (!inside(abs, root) || !inside(lexical, root)) return null;
	const rel = path.relative(root, abs);
	if (rel === "" || SECRET.test(rel) || protectedRel(rel)) return null;
	return { abs, rel, lexical };
}

/**
 * ok when `command` is exactly the login-note recipe over a regular file in
 * the workspace, writing one plain-named file under .tmp/; see the header.
 */
export function loginLineToTmp(command: string, cwd: string | undefined): LoginLine {
	try {
		if (!cwd || !path.isAbsolute(cwd)) return NO;
		const text = command.trim();
		if (!text.startsWith("sed ") || promptControlText(text) !== null) return NO;
		if (decideRules(text).rules.length !== 0) return NO;
		const m = SHAPE.exec(text);
		if (!m) return NO;
		const [, label, , out, file] = m;
		const root = canon(cwd);

		// The input: a regular file inside the workspace, no dot directory, no symlink on its path.
		const src = relInside(file, root);
		if (!src) return NO;
		if (relSegments(src.rel).some((s) => s.startsWith("."))) return NO;
		// A dotenv under another name (prod.env, x.env): SECRET matches only a leading ".env" (8SO, #4096).
		if (DOTENV_NAME.test(path.basename(src.rel))) return NO;
		if (symlinkBelow(root, src.lexical)) return NO;
		const st = lstatSync(src.abs, { throwIfNoEntry: false });
		if (!st || !st.isFile()) return NO;

		// The output: .tmp/NAME under the workspace's real .tmp, a plain data name.
		const dst = relInside(out, root);
		if (!dst) return NO;
		const segs = relSegments(dst.rel);
		if (segs.length !== 2 || segs[0] !== ".tmp") return NO;
		if (WRITE_BAD_NAME.test(segs[1])) return NO;
		const tmp = path.join(root, ".tmp");
		const tst = lstatSync(tmp, { throwIfNoEntry: false });
		if (tst && (tst.isSymbolicLink() || !tst.isDirectory() || realpathSync(tmp) !== tmp)) return NO;
		if (symlinkBelow(root, dst.lexical)) return NO;

		return {
			ok: true,
			reason: `sed copy of the "${label}:" line of ${slash(src.rel)} into ${slash(dst.rel)}, printing nothing`,
		};
	} catch {
		return NO;
	}
}
