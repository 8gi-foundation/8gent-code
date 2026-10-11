/**
 * System One: running the project's own script inside the workspace (#3937).
 *
 * Pilot l5-feature-e2e (11 Oct 2026): the model built a small CLI and tested
 * it with `TODO_FILE=/tmp/todo-test.json bun <work>/src/cli.ts done 1`. The
 * judge has no filesystem to look at; it scored that plain command pYes 0.29
 * to 0.45 (escalate, then block in headless runs). This module reads the
 * script instead.
 *
 * Design after the 8SO review (28 of 28 bypasses of the first, deny-list
 * version): an ALLOWLIST, not a deny-list. The script and every relative file
 * it imports must be made only of tokens this file understands, and may reach
 * only a short list of capabilities. Anything it does not understand is "no
 * opinion" and the command goes to the rules and the judge as before. The
 * gate calls this only in System One's default mode, never in strict/Guarded.
 *
 * `runInProject` answers ok only when ALL hold:
 *   - the command is `[NAME=value ...] bun <file> [args]` or `node <file>
 *     [args]`: plain words only (no quotes, `$`, pipes, redirects, `;`, `&`),
 *     no `bun run` (it would run a package.json script of that name), no
 *     interpreter flag, decideRules fires nothing, no prompt-control text;
 *   - no bunfig.toml and no .env* file in the working directory or on the
 *     way from the script's directory up to it (bun would preload or load
 *     them). The gate cannot rewrite the command, so it refuses instead;
 *   - the script is a .ts/.mts/.js/.mjs regular file whose real path is in
 *     the workspace, not under a dot directory or a protected path;
 *   - every env NAME is read by the script source as process.env.NAME and is
 *     not PATH, HOME, LD_*, DYLD_*, NODE_*, BUN_*, OPENSSL_*, SSL_*, ...; a
 *     value is a plain token or a path in the workspace or under /tmp;
 *   - args are plain; a path-like arg stays in the workspace or /tmp;
 *   - the source passes `checkTokens` (below), after `tokenize` (no regex or
 *     division, no escapes, no non-ASCII, no tagged templates), which permits:
 *       imports: node:fs named {readFileSync, existsSync, readdirSync,
 *         statSync, writeFileSync}, node:path named {join, resolve, basename,
 *         extname}, and relative .ts/.js/.mjs/.json files in the workspace,
 *         each checked in turn (no bare or aliased specifier, no .node/.wasm,
 *         no dynamic import, no import.meta, no `with` attributes);
 *       process.argv/env.NAME/exit/exitCode/cwd/stdout/stderr and Bun.argv,
 *         no other Bun member; env reads of a name the command did not
 *         supply only for NODE_ENV, DEBUG, CI, NO_COLOR, FORCE_COLOR;
 *       no computed member access (only `x[0]` and `[]`), no `.constructor`,
 *         `__proto__`, `prototype`, eval, Function, this, Reflect, Proxy,
 *         Symbol, Object, globalThis, require, Worker, WebAssembly, fetch,
 *         getBuiltinModule, createRequire, and no write or delete API other
 *         than writeFileSync;
 *       fs path argument shape: a string literal, `process.env.NAME` (with an
 *         optional `?? "literal"`), or a call or const of those in the same
 *         file. A literal is a command-line path or a plain relative name;
 *         env NAME must be supplied by the command, and its vetted value is
 *         the path. A write target must also not be source, config, a dot
 *         name or a protected path. So a script cannot read or write a path
 *         it built itself.
 *   - Bun.Transpiler.scan agrees: it finds no import the token pass did not.
 *
 * Known limits, on purpose: it is best effort on a language that cannot be
 * fully analysed by tokens, which is why unknown shapes are refused. Python,
 * `bun test`, `bun x`, jsx/tsx, classes that use `this`, regex, division and
 * non-ASCII text all go to the judge. A file can change between this check and
 * the spawn (same window as s1-rm-single.ts). A global ~/.bunfig.toml is not
 * inspected.
 *
 * Synchronous, never throws.
 */

import { lstatSync, readFileSync, readdirSync, realpathSync } from "node:fs";
import * as path from "node:path";
import { promptControlText } from "../decide/guard";
import { decideRules } from "../decide/rules";
import { hasDotSegment, protectedRel } from "./s1-mv-in-project";
import { inside } from "./s1-rm-nothing";

const PLAIN = /^[A-Za-z0-9._/+,=@: -]+$/;
const ENV_ASSIGN = /^([A-Z][A-Z0-9_]*)=([A-Za-z0-9._/+,@:-]*)$/;
const ENV_DENY =
	/^(PATH|HOME|SHELL|IFS|ENV|TMPDIR|USER|LOGNAME|CDPATH|TERM|LANG|PYTHON.*|BASH.*|SSL.*|OPENSSL.*|(LC|LD|DYLD|NODE|BUN|NPM|GIT|SSH|XDG|CURL|HTTP|HTTPS|ALL|NO|REQUESTS|CA|AWS|GOOGLE|AZURE)_.*)$/;
const AMBIENT_ENV_OK = new Set(["NODE_ENV", "DEBUG", "CI", "NO_COLOR", "FORCE_COLOR"]);
const MAX_ENV = 4;
const SCRIPT_EXT = /\.(?:ts|mts|js|mjs)$/;
const TEMP_ROOTS = ["/tmp", "/private/tmp"];
const SECRET =
	/(^|\/)\.env(\.[\w.-]+)?$|(^|\/)\.env\b|id_rsa|id_ed25519|id_ecdsa|(^|\/)\.ssh(\/|$)|\.aws\/|credentials|\.netrc|\.npmrc|\.git-credentials|keychain|\.pem$|\.key$|\.p12$/;
const BAD_FLAG =
	/^--?(e|p|r|c|i|eval|print|require|import|preload|loader|env-file|cwd|config|inspect(-brk)?|watch|hot|install|conditions|input-type|experimental[\w-]*|bun|shell|filter|silent|elide-lines|if-present|no-env-file)(=.*)?$/;
const MAX_FILES = 30;
const MAX_BYTES = 400_000;
const MAX_DEPTH = 12;

export type RunInProject = { ok: true; reason: string } | { ok: false };
const NO: RunInProject = { ok: false };

// ---------------------------------------------------------------- tokeniser

export type Tok = { t: "id" | "num" | "str" | "p"; v: string };

const KEYWORDS = new Set([
	"return", "case", "typeof", "in", "of", "new", "void", "delete", "yield", "await", "throw", "else", "do",
	"instanceof", "export", "default", "extends", "const", "let", "var", "if", "while", "for", "switch", "as",
	"satisfies", "import", "from", "type", "readonly", "keyof", "is", "async", "static",
]);
const PUNCT = new Set("{}()[];,<>=+-*%&|^!~?:.".split(""));
const ESC_OK = "ntr\\'\"`$0";

/** Source to tokens, or null when it contains anything the allowlist does not read. */
export function tokenize(src: string): Tok[] | null {
	if (/\\[ux]/.test(src) || /<!--|-->/.test(src)) return null;
	// biome-ignore lint/suspicious/noControlCharactersInRegex: rejecting control characters is the point
	if (/[^\t\n\r\x20-\x7e]/.test(src)) return null;
	const out: Tok[] = [];
	const n = src.length;
	let i = 0;
	if (src.startsWith("#!")) while (i < n && src[i] !== "\n") i++;
	const tpl: number[] = [];
	let depth = 0;
	const readTemplateText = (): boolean => {
		let s = "";
		while (i < n) {
			const c = src[i];
			if (c === "`") {
				i++;
				out.push({ t: "str", v: s });
				return true;
			}
			if (c === "$" && src[i + 1] === "{") {
				i += 2;
				out.push({ t: "str", v: s });
				out.push({ t: "p", v: "${" });
				tpl.push(depth);
				return true;
			}
			if (c === "\\") {
				const d = src[i + 1];
				if (d === undefined || !ESC_OK.includes(d)) return false;
				s += d;
				i += 2;
				continue;
			}
			s += c;
			i++;
		}
		return false;
	};
	while (i < n) {
		const c = src[i];
		if (c === " " || c === "\t" || c === "\n" || c === "\r") {
			i++;
		} else if (c === "/") {
			if (src[i + 1] === "/") {
				while (i < n && src[i] !== "\n" && src[i] !== "\r") i++;
			} else if (src[i + 1] === "*") {
				const e = src.indexOf("*/", i + 2);
				if (e === -1) return null;
				i = e + 2;
			} else return null; // regex or division: not read
		} else if (c === '"' || c === "'") {
			let s = "";
			i++;
			for (;;) {
				if (i >= n || src[i] === "\n" || src[i] === "\r") return null;
				const d = src[i];
				if (d === c) {
					i++;
					break;
				}
				if (d === "\\") {
					const e = src[i + 1];
					if (e === undefined || !ESC_OK.includes(e)) return null;
					s += e;
					i += 2;
					continue;
				}
				s += d;
				i++;
			}
			out.push({ t: "str", v: s });
		} else if (c === "`") {
			const prev = out[out.length - 1];
			// A tagged template runs a function on its text (Bun.$`...`).
			if (prev && ((prev.t === "id" && !KEYWORDS.has(prev.v)) || prev.v === ")" || prev.v === "]")) return null;
			i++;
			if (!readTemplateText()) return null;
		} else if (/[A-Za-z_$]/.test(c)) {
			let j = i + 1;
			while (j < n && /[A-Za-z0-9_$]/.test(src[j])) j++;
			out.push({ t: "id", v: src.slice(i, j) });
			i = j;
		} else if (/[0-9]/.test(c)) {
			let j = i + 1;
			while (j < n && /[A-Za-z0-9_]/.test(src[j])) j++;
			if (src[j] === "." && /[0-9]/.test(src[j + 1] ?? "")) {
				j++;
				while (j < n && /[A-Za-z0-9_]/.test(src[j])) j++;
			}
			out.push({ t: "num", v: src.slice(i, j) });
			i = j;
		} else if (c === "}" && tpl.length && tpl[tpl.length - 1] === depth) {
			tpl.pop();
			i++;
			out.push({ t: "p", v: "}$" });
			if (!readTemplateText()) return null;
		} else if (PUNCT.has(c)) {
			if (c === "{") depth++;
			if (c === "}") depth--;
			if (c === "?" && src[i + 1] === "." && !/[0-9]/.test(src[i + 2] ?? "")) {
				out.push({ t: "p", v: "?." });
				i += 2;
			} else if (c === "=" && src[i + 1] === ">") {
				out.push({ t: "p", v: "=>" });
				i += 2;
			} else if (c === "?" && src[i + 1] === "?") {
				out.push({ t: "p", v: "??" });
				i += 2;
			} else if (c === "." && src[i + 1] === "." && src[i + 2] === ".") {
				out.push({ t: "p", v: "..." });
				i += 3;
			} else {
				out.push({ t: "p", v: c });
				i++;
			}
		} else return null; // @ # \ and anything else
	}
	if (tpl.length) return null;
	return out;
}

// ------------------------------------------------------------- source checks

/** Identifiers refused wherever they appear. */
const BANNED_ID = new Set([
	"Bun", "process", "globalThis", "global", "window", "self", "require", "module", "exports", "eval", "Function",
	"constructor", "__proto__", "prototype", "__dirname", "__filename", "this", "arguments", "with", "meta", "fetch",
	"XMLHttpRequest", "WebSocket", "EventSource", "Worker", "SharedWorker", "WebAssembly", "Reflect", "Proxy", "Symbol",
	"getBuiltinModule", "createRequire", "setInterval", "setImmediate", "Deno", "Object", "Intl", "navigator",
	"prepareStackTrace", "getPrototypeOf", "setPrototypeOf", "defineProperty", "defineProperties",
	"getOwnPropertyDescriptor", "getOwnPropertyDescriptors", "getOwnPropertyNames", "getOwnPropertySymbols",
	"__defineGetter__", "__defineSetter__", "__lookupGetter__", "__lookupSetter__", "binding", "dlopen", "mainModule",
	"AsyncFunction", "GeneratorFunction", "Atomics", "debugger", "child_process",
	"writeFile", "appendFile", "appendFileSync", "createWriteStream", "open", "openSync", "rm", "rmSync", "rmdir",
	"rmdirSync", "unlink", "unlinkSync", "rename", "renameSync", "copyFile", "copyFileSync", "cp", "cpSync", "truncate",
	"truncateSync", "symlink", "symlinkSync", "link", "linkSync", "chmod", "chmodSync", "chown", "chownSync", "mkdir",
	"mkdirSync", "mkdtemp", "mkdtempSync", "utimes", "utimesSync", "exec", "execSync", "execFile", "execFileSync",
	"spawn", "spawnSync", "fork",
]);
/** Names refused after a dot. Plain data names (open, link, ...) stay allowed there; Bun and process are checked separately. */
const BANNED_PROP = new Set([
	"constructor", "__proto__", "prototype", "getBuiltinModule", "createRequire", "getPrototypeOf", "setPrototypeOf",
	"defineProperty", "defineProperties", "getOwnPropertyDescriptor", "getOwnPropertyDescriptors", "getOwnPropertyNames",
	"getOwnPropertySymbols", "__defineGetter__", "__defineSetter__", "__lookupGetter__", "__lookupSetter__", "binding",
	"dlopen", "mainModule", "prepareStackTrace", "writeFile", "appendFile", "appendFileSync", "createWriteStream",
	"rmSync", "rmdir", "rmdirSync", "unlink", "unlinkSync", "renameSync", "copyFile", "copyFileSync", "cpSync",
	"truncateSync", "symlink", "symlinkSync", "linkSync", "chmod", "chmodSync", "chown", "chownSync", "mkdir", "mkdirSync",
	"utimes", "utimesSync", "execSync", "execFile", "execFileSync", "spawnSync", "writeFileSync", "openSync",
]);
const STR_BAD = /constructor|__proto__|prototype/;
const FS_OK = new Set(["readFileSync", "existsSync", "readdirSync", "statSync", "writeFileSync"]);
const PATH_OK = new Set(["join", "resolve", "basename", "extname"]);
const PROC_OK = new Set(["argv", "exit", "exitCode", "cwd", "stdout", "stderr"]);
/** Tokens after which a `[` opens an array literal or a type, not a member access. */
const ARRAY_PREV = new Set(["=", "(", ",", ":", "[", "=>", "?", "...", "<", "|", "&", ";", "!", "${", "}$", "+", "??"]);
const WRITE_BAD_NAME =
	/^(package(-lock)?\.json|tsconfig[\w.-]*\.json|bunfig\.toml|bun\.lockb?|makefile|dockerfile|.*\.(ts|tsx|js|jsx|mjs|cjs|mts|cts|toml|sh|node|wasm|so|dylib|yml|yaml|plist)|.*\.config\..*)$/i;

interface Ctx {
	root: string;
	/** NAME -> vetted value of the command's env prefix. */
	env: Map<string, string>;
	/** Command-line path-like tokens (path args and env values). */
	cmdTokens: Set<string>;
	/** NAMEs read as process.env.NAME anywhere in the closure. */
	envReads: Set<string>;
}

function exprEnd(p: Tok | undefined): boolean {
	if (!p) return false;
	if (p.t === "num" || p.t === "str") return true;
	if (p.t === "id") return !KEYWORDS.has(p.v);
	return p.v === ")" || p.v === "]" || p.v === "}";
}

const OPEN = new Set(["[", "(", "{", "${"]);
const CLOSE = new Set(["]", ")", "}", "}$"]);

/** Index of the token closing the bracket opened at `i`, or -1. */
function matching(toks: Tok[], i: number): number {
	let d = 0;
	for (let j = i; j < toks.length; j++) {
		if (toks[j].t !== "p") continue;
		if (OPEN.has(toks[j].v)) d++;
		else if (CLOSE.has(toks[j].v)) {
			d--;
			if (d === 0) return j;
		}
	}
	return -1;
}

type Src = { kind: "lit"; s: string } | { kind: "env"; name: string };

interface Defs {
	fns: Map<string, Tok[]>;
	consts: Map<string, Tok[] | null>;
}

/** `const f = () => EXPR;`, `function f() { return EXPR; }` and `const v = EXPR;` in one file. */
function collectDefs(toks: Tok[]): Defs {
	const fns = new Map<string, Tok[]>();
	const consts = new Map<string, Tok[] | null>();
	const dup = (name: string) => {
		consts.set(name, null);
		fns.delete(name);
	};
	for (let i = 0; i < toks.length; i++) {
		if (toks[i].t !== "id") continue;
		if (toks[i].v === "const" && toks[i + 1]?.t === "id" && toks[i + 2]?.v === "=") {
			const name = toks[i + 1].v;
			let e = i + 3;
			let d = 0;
			while (e < toks.length && !(d === 0 && toks[e].t === "p" && toks[e].v === ";")) {
				if (toks[e].t === "p" && OPEN.has(toks[e].v)) d++;
				if (toks[e].t === "p" && CLOSE.has(toks[e].v)) d--;
				e++;
			}
			if (e >= toks.length) {
				dup(name);
				continue;
			}
			const body = toks.slice(i + 3, e);
			if (consts.has(name) || fns.has(name)) dup(name);
			else if (body[0]?.v === "(" && body[1]?.v === ")" && body[2]?.v === "=>") fns.set(name, body.slice(3));
			else consts.set(name, body);
		} else if (
			toks[i].v === "function" &&
			toks[i + 1]?.t === "id" &&
			toks[i + 2]?.v === "(" &&
			toks[i + 3]?.v === ")" &&
			toks[i + 4]?.v === "{" &&
			toks[i + 5]?.v === "return"
		) {
			let e = i + 6;
			while (e < toks.length && toks[e].v !== ";") e++;
			if (toks[e + 1]?.v === "}") {
				const name = toks[i + 1].v;
				if (consts.has(name) || fns.has(name)) dup(name);
				else fns.set(name, toks.slice(i + 6, e));
			}
		}
	}
	return { fns, consts };
}

/** The path sources an fs path argument can take, or null when its shape is not one of the allowed ones. */
function resolveSources(a: Tok[], defs: Defs, depth = 0): Src[] | null {
	if (depth > 3 || a.length === 0) return null;
	const s = (k: number) => a[k]?.v;
	if (a.length === 1 && a[0].t === "str") return [{ kind: "lit", s: a[0].v }];
	if (a.length >= 5 && s(0) === "process" && s(1) === "." && s(2) === "env" && s(3) === "." && a[4].t === "id") {
		const name = a[4].v;
		if (a.length === 5) return [{ kind: "env", name }];
		if (a.length === 7 && s(5) === "??" && a[6].t === "str") return [{ kind: "env", name }, { kind: "lit", s: a[6].v }];
		return null;
	}
	if (a.length === 3 && a[0].t === "id" && s(1) === "(" && s(2) === ")") {
		const body = defs.fns.get(a[0].v);
		return body ? resolveSources(body, defs, depth + 1) : null;
	}
	if (a.length === 1 && a[0].t === "id") {
		const body = defs.consts.get(a[0].v);
		return body ? resolveSources(body, defs, depth + 1) : null;
	}
	return null;
}

/** `p` with symlinks in its existing part resolved (/tmp -> /private/tmp), so it compares with the real root. */
function canon(p: string): string {
	const tail: string[] = [];
	let cur = p;
	for (;;) {
		try {
			return path.join(realpathSync(cur), ...tail.reverse());
		} catch {
			const up = path.dirname(cur);
			if (up === cur) return p;
			tail.push(path.basename(cur));
			cur = up;
		}
	}
}

function writeTargetOk(p: string, root: string): boolean {
	if (SECRET.test(p)) return false;
	const abs = canon(path.isAbsolute(p) ? path.normalize(p) : path.resolve(root, p));
	// The workspace rules win even when the workspace itself sits under a temp root.
	if (!inside(abs, root)) return underTemp(abs);
	const rel = path.relative(root, abs);
	if (rel === "" || hasDotSegment(rel) || protectedRel(rel)) return false;
	return !WRITE_BAD_NAME.test(path.basename(abs));
}

function safeRelative(p: string): boolean {
	if (!p || p.startsWith("/") || p.includes("\\") || SECRET.test(p)) return false;
	return p.split("/").every((s) => s !== "" && !s.startsWith("."));
}

function sourcesOk(src: Src[], ctx: Ctx, write: boolean): boolean {
	for (const s of src) {
		const value = s.kind === "env" ? ctx.env.get(s.name) : s.s;
		if (value === undefined || value === "") return false;
		const given = ctx.cmdTokens.has(value);
		if (!given && !safeRelative(value)) return false;
		if (s.kind === "env" && !value.includes("/") && !safeRelative(value)) return false;
		if (write && !writeTargetOk(value, ctx.root)) return false;
	}
	return true;
}

/** First call argument of the call opened at `open`. */
function firstArg(toks: Tok[], open: number): Tok[] {
	const close = matching(toks, open);
	if (close === -1) return [];
	let d = 0;
	for (let j = open + 1; j < close; j++) {
		if (toks[j].t !== "p") continue;
		if (OPEN.has(toks[j].v)) d++;
		else if (CLOSE.has(toks[j].v)) d--;
		else if (toks[j].v === "," && d === 0) return toks.slice(open + 1, j);
	}
	return toks.slice(open + 1, close);
}

/** Validate one import/export-from site starting at `i`; returns the index to resume at and any relative import, or null to refuse. */
function moduleSite(toks: Tok[], i: number): { next: number; spec: string; clause: Tok[] } | null {
	const kw = toks[i].v;
	let j = i + 1;
	const clauseStart = j;
	if (kw === "import" && toks[j]?.t === "str") return { next: j, spec: toks[j].v, clause: [] };
	if (kw === "export") {
		if (toks[j]?.v === "{") {
			j = matching(toks, j);
			if (j === -1) return null;
			j++;
		} else if (toks[j]?.v === "*") {
			j++;
			if (toks[j]?.v === "as") j += 2;
		} else return { next: i, spec: "", clause: [] }; // a local export, not a module site
		if (!(toks[j]?.t === "id" && toks[j].v === "from")) return { next: i, spec: "", clause: [] }; // `export { a };`
	} else {
		while (j < toks.length && !(toks[j].t === "id" && toks[j].v === "from")) {
			const tk = toks[j];
			if (!(tk.t === "id" || tk.v === "," || tk.v === "{" || tk.v === "}" || tk.v === "*")) return null;
			j++;
		}
		if (j >= toks.length) return null;
	}
	if (toks[j + 1]?.t !== "str") return null;
	return { next: j + 1, spec: toks[j + 1].v, clause: toks.slice(clauseStart, j) };
}

/** Allowlist pass over one file's tokens. Returns relative imports to follow, or null to refuse. */
function checkTokens(toks: Tok[], ctx: Ctx): { rel: string[]; strings: Set<string> } | null {
	const rel: string[] = [];
	const strings = new Set<string>();
	const defs = collectDefs(toks);
	for (let i = 0; i < toks.length; i++) {
		const tk = toks[i];
		const prev = toks[i - 1];
		const next = toks[i + 1];
		if (tk.t === "str") {
			if (STR_BAD.test(tk.v)) return null;
			strings.add(tk.v);
			continue;
		}
		if (tk.t === "num") continue;
		if (tk.t === "p") {
			if (tk.v !== "[") continue;
			const close = matching(toks, i);
			if (close === -1) return null;
			if (close === i + 1) continue; // `[]`: an empty array or a type
			if (exprEnd(prev)) {
				if (!(close === i + 2 && toks[i + 1].t === "num")) return null; // computed access
				continue;
			}
			const okPrev = prev === undefined || (prev.t === "p" ? ARRAY_PREV.has(prev.v) : KEYWORDS.has(prev.v));
			if (!okPrev) return null;
			const after = toks[close + 1];
			if (after && after.t === "p" && (after.v === ":" || after.v === "(")) return null; // computed key or call
			continue;
		}
		const name = tk.v;
		if (prev?.t === "p" && (prev.v === "." || prev.v === "?.")) {
			if (BANNED_PROP.has(name)) return null;
			continue;
		}
		if (name === "import" || name === "export") {
			if (name === "import" && (next?.v === "(" || next?.v === ".")) return null;
			const site = moduleSite(toks, i);
			if (!site) return null;
			if (site.next === i) continue;
			const spec = site.spec;
			strings.add(spec);
			if (spec.startsWith("./") || spec.startsWith("../")) {
				if (spec.split("/").slice(1).some((p) => p === "" || (p.startsWith(".") && p !== ".."))) return null;
				rel.push(spec);
			} else if (spec === "node:fs" || spec === "fs" || spec === "node:path" || spec === "path") {
				const names = spec.endsWith("fs") ? FS_OK : PATH_OK;
				const c = site.clause;
				if (c[0]?.v !== "{" || c[c.length - 1]?.v !== "}") return null;
				for (const x of c.slice(1, -1)) {
					if (x.v === ",") continue;
					if (x.t !== "id" || !names.has(x.v)) return null;
				}
			} else return null;
			i = site.next;
			continue;
		}
		if (name === "process" || name === "Bun") {
			if (next?.v !== ".") return null;
			const member = toks[i + 2];
			if (member?.t !== "id") return null;
			if (name === "process" && member.v === "env") {
				const nm = toks[i + 4];
				if (toks[i + 3]?.v !== "." || nm?.t !== "id") return null;
				if (!ctx.env.has(nm.v) && !AMBIENT_ENV_OK.has(nm.v)) return null;
				ctx.envReads.add(nm.v);
			} else if (name === "Bun" ? member.v !== "argv" : !PROC_OK.has(member.v)) return null;
			continue;
		}
		if (BANNED_ID.has(name)) return null;
		if (FS_OK.has(name)) {
			if (next?.v !== "(") return null;
			const src = resolveSources(firstArg(toks, i + 1), defs);
			if (!src || !sourcesOk(src, ctx, name === "writeFileSync")) return null;
		}
	}
	return { rel, strings };
}

const CANDIDATES = [".ts", ".mts", ".js", ".mjs", ".json", ".tsx", ".jsx", ".cjs", ".cts", ".node", ".wasm", ".so", ".dylib", ".toml"];

/** The one file `base` names, or null if absent, ambiguous, a symlink, outside root or of a refused type. */
function resolveRelative(base: string, root: string): string | null {
	const direct = lstatOrNull(base);
	if (direct?.isDirectory()) return null;
	const hits: string[] = [];
	if (direct) hits.push(base);
	for (const e of CANDIDATES) if (lstatOrNull(base + e)) hits.push(base + e);
	if (hits.length !== 1) return null;
	const only = hits[0];
	const st = lstatOrNull(only);
	if (!st?.isFile() || st.isSymbolicLink()) return null;
	if (!/\.(ts|mts|js|mjs|json)$/.test(only)) return null;
	const real = realpathSync(only);
	return inside(real, root) ? real : null;
}

type ScanFn = new (o: { loader: string }) => { scan(s: string): { imports: Array<{ path: string }> } };

/** Check the entry script and its relative imports. */
function checkSource(entry: string, ctx: Ctx): boolean {
	const Transpiler = (globalThis as { Bun?: { Transpiler?: ScanFn } }).Bun?.Transpiler;
	if (!Transpiler) return false;
	const seen = new Set<string>();
	const queue: Array<[string, number]> = [[entry, 0]];
	let bytes = 0;
	while (queue.length) {
		const [file, depth] = queue.pop() as [string, number];
		if (seen.has(file)) continue;
		if (seen.size >= MAX_FILES || depth > MAX_DEPTH) return false;
		seen.add(file);
		const relp = path.relative(ctx.root, file);
		if (hasDotSegment(relp) || protectedRel(relp) || SECRET.test(relp)) return false;
		if (file.endsWith(".json")) {
			bytes += lstatSync(file).size;
			if (bytes > MAX_BYTES) return false;
			continue;
		}
		const src = readFileSync(file, "utf8");
		bytes += src.length;
		if (bytes > MAX_BYTES) return false;
		const toks = tokenize(src);
		if (!toks) return false;
		const checked = checkTokens(toks, ctx);
		if (!checked) return false;
		// Cross-check with the parser: it may not see an import the token pass did not.
		try {
			const scan = new Transpiler({ loader: /\.m?ts$/.test(file) ? "ts" : "js" }).scan(src);
			for (const im of scan.imports) if (!checked.strings.has(im.path)) return false;
		} catch {
			return false;
		}
		for (const spec of checked.rel) {
			const resolved = resolveRelative(path.resolve(path.dirname(file), spec), ctx.root);
			if (!resolved) return false;
			queue.push([resolved, depth + 1]);
		}
	}
	return true;
}

// ----------------------------------------------------------------- command

function lstatOrNull(p: string): ReturnType<typeof lstatSync> | null {
	try {
		return lstatSync(p);
	} catch {
		return null;
	}
}

function underTemp(p: string): boolean {
	return TEMP_ROOTS.some((r) => p === r || p.startsWith(`${r}/`));
}

function pathOk(token: string, root: string): boolean {
	if (SECRET.test(token)) return false;
	if (token.split("/").some((s) => s === "..")) return false;
	const abs = path.isAbsolute(token) ? path.normalize(token) : path.resolve(root, token);
	if (!(inside(abs, root) || underTemp(abs))) return false;
	return !lstatOrNull(abs)?.isSymbolicLink();
}

/** bunfig.toml or a .env* file in `dir` (bun would preload or load it). */
function configInDir(dir: string): boolean {
	try {
		return readdirSync(dir).some((n) => n === "bunfig.toml" || n === ".bunfig.toml" || n === ".env" || n.startsWith(".env."));
	} catch {
		return true;
	}
}

/**
 * ok when `command` is `[NAME=value ...] bun|node <script> [args]` and the
 * script, with everything it imports, passes the allowlist; see the header.
 */
export function runInProject(command: string, cwd: string | undefined): RunInProject {
	try {
		if (!cwd || !path.isAbsolute(cwd)) return NO;
		const text = command.trim();
		if (!PLAIN.test(text) || promptControlText(text) !== null) return NO;
		if (decideRules(text).rules.length !== 0) return NO;
		const root = realpathSync(cwd);
		const words = text.split(/ +/);
		const ctx: Ctx = { root, env: new Map(), cmdTokens: new Set(), envReads: new Set() };
		let i = 0;
		while (i < words.length && !words[i].startsWith("-") && words[i].includes("=")) {
			const m = ENV_ASSIGN.exec(words[i]);
			if (!m || ENV_DENY.test(m[1]) || ctx.env.size >= MAX_ENV || ctx.env.has(m[1])) return NO;
			const v = m[2];
			if (SECRET.test(v) || v === "." || v === ".." || v.endsWith(".")) return NO;
			if (v.includes("/") && !pathOk(v, root)) return NO;
			ctx.env.set(m[1], v);
			ctx.cmdTokens.add(v);
			i++;
		}
		const bin = words[i++];
		if (bin !== "bun" && bin !== "node") return NO;
		const scriptArg = words[i++];
		if (!scriptArg || scriptArg.startsWith("-") || !SCRIPT_EXT.test(scriptArg)) return NO;
		if (scriptArg.split("/").some((s) => s === "..") || SECRET.test(scriptArg)) return NO;
		const scriptAbs = path.isAbsolute(scriptArg) ? path.normalize(scriptArg) : path.resolve(root, scriptArg);
		const st = lstatOrNull(scriptAbs);
		if (!st || !st.isFile() || st.isSymbolicLink()) return NO;
		const realScript = realpathSync(scriptAbs);
		if (!inside(realScript, root)) return NO;

		for (const a of words.slice(i)) {
			if (a.startsWith("-")) {
				if (!/^--?[A-Za-z][A-Za-z0-9-]*(=[A-Za-z0-9._/+,@:-]*)?$/.test(a) || BAD_FLAG.test(a)) return NO;
			}
			const eq = a.indexOf("=");
			for (const tok of eq === -1 ? [a] : [a, a.slice(eq + 1)]) {
				if (SECRET.test(tok) || tok === "." || tok.endsWith(".")) return NO;
				if (tok.includes("/") && !pathOk(tok, root)) return NO;
				if (tok.includes("/")) ctx.cmdTokens.add(tok);
			}
		}
		// bun loads bunfig.toml and .env* from the working directory, and a preload there runs code.
		for (let d = path.dirname(realScript); inside(d, root); d = path.dirname(d)) {
			if (configInDir(d)) return NO;
			if (d === root) break;
		}
		if (!checkSource(realScript, ctx)) return NO;
		// Every env name the command sets must be one the source reads.
		for (const name of ctx.env.keys()) if (!ctx.envReads.has(name)) return NO;
		return {
			ok: true,
			reason: `run of ${path.relative(root, realScript)}: a workspace script limited to reading and writing the paths on its command line`,
		};
	} catch {
		return NO;
	}
}
