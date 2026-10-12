/**
 * System One: running a script this session wrote in the workspace's .tmp (#4121).
 *
 * Pilot design-mockup-practice (main 00f7e8ae, run 2026-10-12_224020): the
 * layout check tool could not render the page, so the model wrote
 * `.tmp/serve.sh` with write_file and ran `bash .tmp/serve.sh`. The judge has
 * no filesystem to look at; it scored that plain command pYes 0.4913 and
 * blocked it, final. This module reads the script instead. Same design as
 * s1-rm-own-dir.ts (#4105): an ALLOWLIST of one exact shape. Anything else is
 * "no opinion" and goes to the judge as before. The gate calls this only in
 * System One's default mode, after every earlier layer allowed the command.
 *
 * `runOwnScript` answers ok only when ALL hold:
 *   - POSIX (never on win32), an absolute working directory, a session record;
 *   - the whole command is `INTERP PATH`: exactly two words of
 *     [A-Za-z0-9._/+,=@:-], so no flag, `--`, env prefix, quote, glob, `$`,
 *     redirect, pipe, `;`, `&`, newline or extra argument; INTERP is bash or
 *     sh (PATH ends in .sh or has no extension), python3 (.py) or bun (.ts,
 *     .mts, .js, .mjs); decideRules fires nothing, no prompt-control text;
 *   - PATH is `.tmp/NAME...` relative to the working directory with no `.`,
 *     `..` or empty segment; no component from the workspace root down to it
 *     is a symlink; its real path is inside the workspace's real .tmp;
 *   - the file is a regular file with nlink 1, owned by this process's user,
 *     born no earlier than this process started (and the file system reports
 *     a birth time), and the session's record (s1-created-files.ts) says this
 *     session created it and it is still that file (device, inode, change and
 *     birth time, size): a pre-existing, renamed-in or replaced file fails;
 *   - for bun, no bunfig.toml and no .env* in the working directory (bun
 *     would preload or load them);
 *   - its text (at most 64 KB, ASCII only) passes `scriptProblem` below: no
 *     listener on anything but loopback (and a server that binds every
 *     interface by default must name loopback), no URL to a non-loopback
 *     host, no absolute path outside the workspace, no sudo, no recursive
 *     delete, no home directory, no spawn, eval or encoded text, no package
 *     install. A shell script must also be literal: no `$`, backtick or
 *     backslash, and decideRules fires nothing on any line.
 *
 * When the command has the right shape but the script fails, the result
 * carries a hint for the block message saying what would pass.
 *
 * Known limits, on purpose: the text scan is a deny-list over python and
 * JavaScript, which cannot be complete (a string built at run time is not
 * seen); the shell case is literal-only for that reason. The record, not the
 * scan, is the main guard: the file must be one this session wrote. TOCTOU
 * between this check and the spawn, as for the sibling lanes. A long-running
 * server still runs in the foreground of run_command.
 *
 * Synchronous, never throws.
 */

import { existsSync, lstatSync, readFileSync, readdirSync, realpathSync } from "node:fs";
import * as path from "node:path";
import { promptControlText } from "../decide/guard";
import { decideRules } from "../decide/rules";
import type { CreatedFiles } from "./s1-created-files";
import { inside } from "./s1-rm-nothing";

export type RunOwnScript = { ok: true; reason: string } | { ok: false; hint?: string };

const WORD = /^[A-Za-z0-9._/+,=@:-]+$/;
const INTERP: Record<string, RegExp> = {
	bash: /(^|\/)[^./]+(\.sh)?$/,
	sh: /(^|\/)[^./]+(\.sh)?$/,
	python3: /\.py$/,
	bun: /\.(ts|mts|js|mjs)$/,
};
const MAX_BYTES = 64 * 1024;
const NO: RunOwnScript = { ok: false };
/** When this process started, in ns, less a second for coarse clocks. */
const SINCE_NS = BigInt(Math.floor(performance.timeOrigin) - 1000) * 1_000_000n;

const WHAT_PASSES =
	"A script runs without review only as `bash|sh|python3|bun .tmp/FILE` with no other words, where FILE is one this session wrote with write_file, binds nothing but 127.0.0.1 (for example `python3 -m http.server 8731 --bind 127.0.0.1`), fetches only loopback URLs, and names no path outside the workspace. Shell scripts must be literal commands, with no `$` or backtick.";

function hint(why: string): RunOwnScript {
	return { ok: false, hint: `${why} ${WHAT_PASSES}` };
}

const LOOPBACK = /^(127(\.\d{1,3}){3}|::1|\[::1\]|localhost)$/i;
const isLoopback = (h: string) => LOOPBACK.test(h);

/** Patterns refused anywhere in a script, with the reason given. */
const DENY: Array<[RegExp, string]> = [
	[/\b(sudo|doas|pkexec)\b|\bsu\s+-/, "it uses sudo"],
	[
		/\brm\s+(-[A-Za-z]*[rR]|--recursive)|\brmtree\b|recursive\s*[:=]\s*(true|True)/,
		"it deletes recursively",
	],
	[
		/\bHOME\b|expanduser|homedir|Path\.home|(^|[^\w.~-])~(?=[/\s"']|$)/m,
		"it names the home directory",
	],
	[
		/\b(eval|exec|compile|getattr|globals|__import__|Function|require|import)\s*\(|\bbase64\b|\\x[0-9a-fA-F]{2}|\\u[0-9a-fA-F]{4}|importlib|\bctypes\b|\bpty\b/,
		"it evaluates built or encoded code",
	],
	[
		/\bsubprocess\b|\bos\.(system|popen|exec\w*|spawn\w*|fork)\b|child_process|Bun\.(spawn\w*|\$)|\bspawn(Sync)?\s*\(/,
		"it starts other programs",
	],
	[/\b(npx|bunx|pip3?|npm|pnpm|yarn)\b|\bbun\s+(add|install|x)\b/, "it installs packages"],
	[/\b(nc|ncat|netcat|socat)\b/, "it opens a raw network listener"],
	[/(^|[\s;&|])(eval|source)\b|(^|[\s;&|])\.\s+\S/m, "it runs text it did not spell out"],
];

/** The host of each `scheme://host` in `text`; empty when no literal host follows. */
function urlHosts(text: string): string[] {
	const out: string[] = [];
	for (const m of text.matchAll(/:\/\/(\[[^\]]*\]|[^/\s"'`:?#)]*)/g)) out.push(m[1] ?? "");
	return out;
}

/** Null when the listener parts of `text` stay on loopback, else why not. */
function bindProblem(text: string): string | null {
	for (const m of text.matchAll(/\b\d{1,3}(?:\.\d{1,3}){3}\b/g))
		if (!isLoopback(m[0])) return `it names the address ${m[0]}, which is not loopback`;
	for (const m of text.matchAll(/["']\s*([0-9a-fA-F:]*::[0-9a-fA-F:]*|\[[0-9a-fA-F:]*\])\s*["']/g))
		if (!isLoopback(m[1] ?? "")) return `it names the address ${m[1]}, which is not loopback`;
	for (const m of text.matchAll(
		/(--bind|--host|(?<![\w-])-b|\bhost(?:name)?\s*[=:]|\bHOST\s*=|\blisten\b)\s*["']?([^\s"',)}]*)/g,
	)) {
		const v = m[2] ?? "";
		if (!isLoopback(v))
			return `it binds \`${v || "(nothing)"}\` with ${m[1]?.trim()}, which is not loopback`;
	}
	if (/\(\s*\(\s*(""|'')/.test(text)) return "it binds an empty host, which means every interface";
	for (const line of text.split("\n")) {
		if (
			/http\.server|SimpleHTTPServer/.test(line) &&
			/-m\s+http\.server|SimpleHTTPServer/.test(line)
		) {
			if (!/(--bind|(?<![\w-])-b)\s+(127(\.\d{1,3}){3}|localhost|::1)\b/.test(line))
				return "`python3 -m http.server` binds every interface unless it is given `--bind 127.0.0.1`";
		}
	}
	if (
		/Bun\.serve/.test(text) &&
		!/hostname\s*:\s*["'](127(\.\d{1,3}){3}|localhost|::1)["']/.test(text)
	)
		return '`Bun.serve` binds every interface unless it is given `hostname: "127.0.0.1"`';
	if (/\.listen\(\s*[^,()]+\)/.test(text))
		return "`.listen(port)` with no host binds every interface";
	return null;
}

/**
 * Null when every absolute path in `text` is in the workspace (or /dev/null
 * and friends), else why not. Outside shell, a lone `/` after a space is
 * division, not the root directory.
 */
function pathProblem(text: string, root: string, cwd: string, shell: boolean): string | null {
	const noUrls = text.replace(/[A-Za-z][A-Za-z0-9+.-]*:\/\/\S*/g, " ");
	for (const m of noUrls.matchAll(/(?:^|[\s"'=(,:[\]{}<>|;&])(\/[A-Za-z0-9._/@+-]*)/gm)) {
		const p = m[1] ?? "/";
		if (/^\/dev\/(null|stdout|stderr)$/.test(p)) continue;
		if (!shell && p === "/" && /^\s/.test(m[0])) continue;
		const lexical = path.resolve(p);
		let real = lexical;
		try {
			real = realpathSync(lexical);
		} catch {
			// Not there yet: judge it by its spelling.
		}
		const inWs = (q: string) => inside(q, root) || inside(q, cwd);
		if (!inWs(lexical) || !inWs(real)) return `it names \`${p}\`, which is outside the workspace`;
	}
	return null;
}

/** Null when the script text is acceptable for `interp` (see the header), else why not. */
export function scriptProblem(
	src: string,
	interp: string,
	root: string,
	cwd: string,
): string | null {
	if (src.length > MAX_BYTES) return "it is larger than 64 KB";
	if (/[^\t\n\r\x20-\x7e]/.test(src)) return "it has non-ASCII or control characters";
	if (promptControlText(src) !== null) return "it carries prompt-control text";
	const lines = src.split("\n");
	if (lines[0]?.startsWith("#!")) {
		if (
			!/^#!(\/usr\/bin\/env (ba)?sh|\/usr\/bin\/env python3|\/usr\/bin\/env bun|\/bin\/(ba)?sh|\/usr\/bin\/(ba)?sh|\/usr\/bin\/python3)\s*$/.test(
				lines[0],
			)
		)
			return "its #! line names an unexpected interpreter";
		lines.shift();
	}
	const comment = interp === "bun" ? /^\s*\/\// : /^\s*#/;
	const code = lines.filter((l) => !comment.test(l)).join("\n");
	const shell = interp === "bash" || interp === "sh";
	if (shell) {
		if (/[$`\\]/.test(code))
			return "a shell script here must be literal: it uses `$`, a backtick or a backslash";
		for (const line of code.split("\n")) {
			const fired = decideRules(line).rules;
			if (fired.length > 0) return `its line \`${line.trim()}\` fires rule ${fired.join(", ")}`;
		}
	}
	for (const [re, why] of DENY) if (re.test(code)) return why;
	for (const h of urlHosts(code))
		if (!isLoopback(h)) return `it fetches \`${h || "a URL it builds"}\`, which is not loopback`;
	if (/\b(curl|wget)\b/.test(code) && urlHosts(code).length === 0)
		return "it runs curl or wget without a literal loopback URL";
	return bindProblem(code) ?? pathProblem(code, root, cwd, shell);
}

/**
 * ok when `command` runs, with no other words, a script this session wrote
 * under the workspace's .tmp whose text stays on loopback and in the
 * workspace; see the header.
 */
export function runOwnScript(
	command: string,
	cwd: string | undefined,
	created: CreatedFiles | undefined,
): RunOwnScript {
	try {
		if (process.platform === "win32" || !cwd || !path.isAbsolute(cwd) || !created) return NO;
		const text = command.trim();
		const words = text.split(" ");
		if (words.length !== 2 || !words.every((w) => WORD.test(w))) return NO;
		const [interp, rel] = words as [string, string];
		const ext = INTERP[interp];
		if (!ext) return NO;
		if (promptControlText(text) !== null || decideRules(text).rules.length > 0) return NO;
		const segs = rel.split("/");
		if (
			segs[0] !== ".tmp" ||
			segs.length < 2 ||
			segs.some((s) => s === "" || s === "." || s === "..")
		)
			return NO;
		if (!ext.test(rel)) return hint(`\`${interp}\` does not match the file type of \`${rel}\`.`);
		const root = realpathSync(cwd);
		let cur = root;
		for (const s of segs) {
			cur = path.join(cur, s);
			const st = lstatSync(cur, { throwIfNoEntry: false });
			if (!st) return NO;
			if (st.isSymbolicLink()) return hint(`\`${rel}\` has a symlink on its path.`);
		}
		const tmp = path.join(root, ".tmp");
		if (realpathSync(tmp) !== tmp || !inside(realpathSync(cur), tmp))
			return hint(`\`${rel}\` is not inside the workspace's .tmp.`);
		const st = lstatSync(cur, { bigint: true });
		if (!st.isFile()) return hint(`\`${rel}\` is not a regular file.`);
		if (st.nlink !== 1n) return hint(`\`${rel}\` has more than one hard link.`);
		if (typeof process.getuid !== "function" || st.uid !== BigInt(process.getuid()))
			return hint(`\`${rel}\` is not owned by this session's user.`);
		if (st.birthtimeNs <= 0n || st.birthtimeNs < SINCE_NS)
			return hint(`\`${rel}\` was not created during this session.`);
		if (!created.createdBySession(cur))
			return hint(`\`${rel}\` is not a file this session wrote (or it changed since).`);
		if (interp === "bun") {
			if (
				existsSync(path.join(cwd, "bunfig.toml")) ||
				readdirSync(cwd).some((n) => n.startsWith(".env"))
			)
				return hint("bun would load the bunfig.toml or .env file in the working directory.");
		}
		const why = scriptProblem(readFileSync(cur, "utf8"), interp, root, cwd);
		if (why) return hint(`\`${rel}\`: ${why}.`);
		return {
			ok: true,
			reason: `${interp} of ${rel}, a script this session wrote: loopback only, workspace paths only`,
		};
	} catch {
		return NO;
	}
}
