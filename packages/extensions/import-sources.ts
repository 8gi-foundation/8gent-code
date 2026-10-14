/**
 * `8gent ext import <source>`: bring extensions, commands and MCP servers
 * over from other tools. Mechanical mappings only: nothing is translated by a
 * model, nothing is fetched, and every item records its source, path and
 * sha256 in ~/.8gent/imports.json.
 *
 *   pi           Pi extensions -> ~/.8gent/extensions/pi-* (pi-compat.ts).
 *                Code: runs only when the session has extensions on, through
 *                the extension_call policy gate.
 *   claude-code  ~/.claude/commands/*.md -> prompt templates, staged in
 *                ~/.8gent/imports/claude-code/prompts until `--enable` copies
 *                them into ~/.8gent/prompts. ~/.claude/skills needs no copy:
 *                8gent already reads it (packages/skills, SkillManager); the
 *                import lists and hashes what is there.
 *   mcp          MCP servers from Claude Code (~/.claude.json, ./.mcp.json) or
 *                Pi (<agent-dir>/mcp.json) -> `pendingServers` in
 *                ~/.8gent/mcp.json. The MCP loader reads only `servers` /
 *                `mcpServers`, so a pending server never starts until
 *                `8gent ext approve-mcp <name>` moves it.
 *   anything else: refused, naming what is missing.
 */

import { createHash } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import { resolveHome } from "../core/home";
import { defaultConfigPath as defaultMcpConfigPath } from "../mcp/config";
import { defaultPiExtensionsDir } from "./pi-compat";
import { parseTemplate } from "./prompts";

export const SUPPORTED_SOURCES = ["pi", "claude-code", "mcp"] as const;

export interface ImportPaths {
	/** ~/.claude */
	claudeDir: string;
	/** ~/.claude.json (Claude Code's user and per-project settings, MCP servers included) */
	claudeJson: string;
	/** Project folder, for ./.mcp.json and Claude Code's per-project servers */
	cwd: string;
	/** Pi's agent folder (~/.pi/agent or $PI_CODING_AGENT_DIR) */
	piAgentDir: string;
	/** ~/.8gent */
	eightDir: string;
	/** ~/.8gent/mcp.json */
	mcpConfig: string;
}

export function defaultImportPaths(env: NodeJS.ProcessEnv = process.env): ImportPaths {
	const home = resolveHome();
	if (!home || !path.isAbsolute(home))
		throw new Error(`no absolute home directory (got "${home}")`);
	return {
		claudeDir: path.join(home, ".claude"),
		claudeJson: path.join(home, ".claude.json"),
		cwd: process.cwd(),
		piAgentDir: path.dirname(defaultPiExtensionsDir(env)),
		eightDir: path.join(home, ".8gent"),
		mcpConfig: defaultMcpConfigPath(),
	};
}

export interface ImportRecord {
	source: string;
	kind: "prompt" | "skill" | "mcp";
	name: string;
	/** Where it came from. */
	path: string;
	sha256: string;
	importedAt: string;
	/** Off until the person enables it (prompts: --enable; mcp: approve-mcp). Skills are read in place. */
	enabled: boolean;
	/** Features of the source the mapping does not carry over, named. */
	notCarried?: string[];
}

const sha = (data: string | Buffer) => createHash("sha256").update(data).digest("hex");

function recordImports(eightDir: string, records: ImportRecord[]): void {
	const file = path.join(eightDir, "imports.json");
	let all: ImportRecord[] = [];
	try {
		all = JSON.parse(fs.readFileSync(file, "utf8")) as ImportRecord[];
	} catch {
		all = [];
	}
	const key = (r: ImportRecord) => `${r.source}:${r.kind}:${r.name}`;
	const byKey = new Map(all.map((r) => [key(r), r]));
	for (const r of records) byKey.set(key(r), r);
	writePrivate(file, `${JSON.stringify([...byKey.values()], null, 2)}\n`);
}

function safeName(raw: string): string {
	const s = raw
		.toLowerCase()
		.replace(/\.md$/i, "")
		.replace(/[^a-z0-9_-]+/g, "-")
		.replace(/^-+|-+$/g, "")
		.slice(0, 56);
	return /^[a-z0-9]/.test(s) ? s : `x${s}`;
}

// ── claude-code ──────────────────────────────────────────────────────────────

/**
 * Claude Code runs a `!`command`` line and pastes its output. 8gent does not:
 * each such line is wrapped in a code fence marked "not-run", so the model
 * reads it as quoted text and never as an instruction to run it.
 */
export function fenceShellLines(text: string): string {
	return text
		.split(/\r?\n/)
		.map((line) => (/!`[^`]+`/.test(line) ? `\`\`\`not-run\n${line}\n\`\`\`` : line))
		.join("\n");
}

/** Claude Code command features our prompt templates do not run, named for the report. */
function claudeCommandGaps(text: string): string[] {
	const gaps: string[] = [];
	const fm = text.replace(/\r\n/g, "\n").match(/^---\n([\s\S]*?)\n---/)?.[1] ?? "";
	for (const key of ["allowed-tools", "model", "argument-hint", "disable-model-invocation"]) {
		if (new RegExp(`^${key}:`, "m").test(fm)) gaps.push(`frontmatter "${key}"`);
	}
	if (/!`[^`]+`/.test(text)) gaps.push("!`command` lines (kept in a not-run code fence)");
	if (/(^|\s)@[\w./~-]+/.test(text.replace(/^---[\s\S]*?---/, "")))
		gaps.push("@file references (stay as plain text)");
	return gaps;
}

function importClaudeCode(
	paths: ImportPaths,
	enable: boolean,
): { lines: string[]; records: ImportRecord[] } {
	const now = new Date().toISOString();
	const lines: string[] = [];
	const records: ImportRecord[] = [];

	// Commands -> prompt templates.
	const commandsDir = path.join(paths.claudeDir, "commands");
	const staged = path.join(paths.eightDir, "imports", "claude-code", "prompts");
	const live = path.join(paths.eightDir, "prompts");
	const files = fs.existsSync(commandsDir)
		? fs
				.readdirSync(commandsDir)
				.filter((f) => f.toLowerCase().endsWith(".md"))
				.sort()
		: [];
	lines.push(`Claude Code commands (${commandsDir}): ${files.length}`);
	for (const f of files) {
		const src = path.join(commandsDir, f);
		const text = fs.readFileSync(src, "utf8");
		const name = `claude-${safeName(f)}`;
		const gaps = claudeCommandGaps(text);
		const safe = fenceShellLines(text);
		fs.mkdirSync(staged, { recursive: true });
		fs.writeFileSync(path.join(staged, `${name}.md`), safe);
		if (enable) {
			fs.mkdirSync(live, { recursive: true });
			fs.writeFileSync(path.join(live, `${name}.md`), safe);
		}
		const desc = parseTemplate(text).description;
		records.push({
			source: "claude-code",
			kind: "prompt",
			name,
			path: src,
			sha256: sha(text),
			importedAt: now,
			enabled: enable,
			...(gaps.length ? { notCarried: gaps } : {}),
		});
		const state = gaps.length ? "partial" : "loaded";
		lines.push(
			`  /${name}  ${state}  ${enable ? "enabled" : "staged (off)"}${desc ? `  ${desc}` : ""}${gaps.length ? `  not carried: ${gaps.join("; ")}` : ""}`,
		);
	}
	if (files.length && !enable) {
		lines.push("  Staged only. Run again with --enable to use them as /commands.");
	}

	// Skills: already read in place.
	const skillsDir = path.join(paths.claudeDir, "skills");
	const skills = fs.existsSync(skillsDir)
		? fs
				.readdirSync(skillsDir)
				.filter((d) => fs.existsSync(path.join(skillsDir, d, "SKILL.md")))
				.sort()
		: [];
	lines.push(
		`Claude Code skills (${skillsDir}): ${skills.length}. 8gent already reads this folder, so nothing is copied; their hashes are recorded.`,
	);
	for (const d of skills) {
		const src = path.join(skillsDir, d, "SKILL.md");
		records.push({
			source: "claude-code",
			kind: "skill",
			name: d,
			path: src,
			sha256: sha(fs.readFileSync(src)),
			importedAt: now,
			enabled: true,
		});
	}
	return { lines, records };
}

// ── mcp ──────────────────────────────────────────────────────────────────────

interface McpEntry {
	command?: string;
	args?: string[];
	env?: Record<string, string>;
	url?: string;
	headers?: Record<string, string>;
	type?: string;
	[key: string]: unknown;
}

/** Where MCP servers come from, per tool. Only files that exist are read. */
function mcpSources(
	paths: ImportPaths,
	from: string,
): Array<{ label: string; file: string; pick: (j: unknown) => Record<string, McpEntry> }> {
	const servers = (j: unknown) =>
		((j as { mcpServers?: Record<string, McpEntry> })?.mcpServers ?? {}) as Record<
			string,
			McpEntry
		>;
	const claude = [
		{ label: "Claude Code (user)", file: paths.claudeJson, pick: servers },
		{
			label: "Claude Code (this project)",
			file: paths.claudeJson,
			pick: (j: unknown) =>
				((j as { projects?: Record<string, { mcpServers?: Record<string, McpEntry> }> })
					?.projects?.[paths.cwd]?.mcpServers ?? {}) as Record<string, McpEntry>,
		},
		{ label: "project .mcp.json", file: path.join(paths.cwd, ".mcp.json"), pick: servers },
	];
	const pi = [{ label: "Pi", file: path.join(paths.piAgentDir, "mcp.json"), pick: servers }];
	if (from === "claude-code") return claude;
	if (from === "pi") return pi;
	return [...claude, ...pi];
}

/**
 * Mask secret-looking parts of a string: KEY=value pairs, known token shapes
 * (GitHub, OpenAI-style sk-, Slack, AWS), Authorization schemes, URL
 * userinfo and query values. Used on everything an import or approve prints.
 */
const HEADER_FLAG = /^(?:-H|--header)$/;
/** Programs whose -k / -K value is masked (HTTP clients). */
const HTTP_CLIENTS = new Set([
	"curl",
	"curl.exe",
	"wget",
	"http",
	"https",
	"xh",
	"httpie",
	"grpcurl",
	"websocat",
]);

/** Path segments that hold a secret in an MCP or webhook URL: after /sse/, /token/ and so on, or random-looking. */
function redactUrl(url: string): string {
	let u: URL;
	try {
		u = new URL(url);
	} catch {
		return url;
	}
	const marker =
		/^(?:sse|token|tokens|key|keys|secret|secrets|auth|apikey|api-key|api_key|hook|hooks|webhook|webhooks)$/i;
	const segments = u.pathname.split("/");
	let changed = false;
	for (let i = 1; i < segments.length; i++) {
		let seg = segments[i] || "";
		try {
			seg = decodeURIComponent(seg);
		} catch {
			/* keep it encoded */
		}
		if (!seg) continue;
		const afterMarker = marker.test(segments[i - 1] || "");
		const random =
			seg.length >= 16 && /[A-Za-z]/.test(seg) && /[0-9]/.test(seg) && entropy(seg) >= 3.3;
		if (afterMarker || random || isDottedToken(seg)) {
			segments[i] = "***";
			changed = true;
		}
	}
	if (!changed && !u.username && !u.password && !u.search && !u.hash) return url;
	const userinfo = u.username || u.password ? "***@" : "";
	const query = u.search ? u.search.replace(/([?&][^=&]+=)[^&]*/g, "$1***") : "";
	return `${u.protocol}//${userinfo}${u.host}${segments.join("/")}${query}${u.hash ? "#***" : ""}`;
}

/** abc.def.ghi with 20+ characters, a digit and a long segment: a signed or dotted token, not a host name. */
function isDottedToken(s: string): boolean {
	if (s.length < 20 || !/^[A-Za-z0-9_-]+(?:\.[A-Za-z0-9_-]+)+$/.test(s)) return false;
	const parts = s.split(".");
	// Two segments (id.secret): both must look random, so host names stay readable.
	if (parts.length === 2) {
		return parts.every(
			(x) => x.length >= 6 && /[A-Za-z]/.test(x) && /[0-9]/.test(x) && entropy(x) >= 2.5,
		);
	}
	return /[0-9]/.test(s) && Math.max(...parts.map((x) => x.length)) >= 10;
}

export function redact(text: string): string {
	return text
		.replace(/\b(?:https?|wss?):\/\/[^\s"']+/g, (m) => redactUrl(m))
		.replace(/(?<![\w.])[A-Za-z0-9_-]+(?:\.[A-Za-z0-9_-]+){2,}(?![\w.])/g, (m) =>
			isDottedToken(m) ? "***" : m,
		)
		.replace(/\bgh[pousr]_[A-Za-z0-9]{16,}/g, "***")
		.replace(/\bgithub_pat_[A-Za-z0-9_]{20,}/g, "***")
		.replace(/\bsk-[A-Za-z0-9_-]{16,}/g, "***")
		.replace(/\bsk_(?:live|test)_[A-Za-z0-9]{8,}/g, "***")
		.replace(/\bsk_[A-Za-z0-9]{16,}/g, "***")
		.replace(/\bAIza[0-9A-Za-z_-]{30,}/g, "***")
		.replace(/\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{6,}/g, "***")
		.replace(/\bxox[abposr]-[A-Za-z0-9-]{10,}/g, "***")
		.replace(/\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/g, "***")
		.replace(/\b(Authorization\s*:\s*)("[^"]*"|'[^']*'|[^\s"']+(?:\s+[^\s"']+)?)/gi, "$1***")
		.replace(/\b(Bearer|Basic|Token)\s+[A-Za-z0-9._~+/=-]{6,}/gi, "$1 ***")
		.replace(
			/((?:^|\s)(?:--?[\w-]*(?:key|token|secret|password|passwd|pass|pw|auth|cred)[\w-]*|-p))(\s+|=)("[^"]*"|'[^']*'|\S+)/gi,
			"$1$2***",
		)
		.replace(/((?:^|\s)(?:-H|--header))(\s+)("[^"]*"|'[^']*'|\S+)/g, "$1$2***")
		.replace(
			/^((?:\S*[\\/])?(?:curl|curl\.exe|wget|https?|xh|httpie|grpcurl|websocat)\b.*?\s-[kK])(\s+)("[^"]*"|'[^']*'|\S+)/,
			"$1$2***",
		)
		.replace(/(\/\/)[^/@\s]+@/g, "$1***@")
		.replace(/([?&][^=&\s]+=)[^&\s]+/g, "$1***")
		.replace(/\b([A-Za-z_][\w.-]*)=(\S+)/g, "$1=***");
}

/** Shannon entropy of a string, bits per character. */
function entropy(s: string): number {
	const counts = new Map<string, number>();
	for (const ch of s) counts.set(ch, (counts.get(ch) ?? 0) + 1);
	let h = 0;
	for (const n of counts.values()) {
		const p = n / s.length;
		h -= p * Math.log2(p);
	}
	return h;
}

/**
 * Known secret token shapes. For a server's command and args these are the
 * only in-text masks: a script or a NAME=value pair is never masked, because
 * hiding it would hide the code the person is approving. None of these
 * character classes can hold shell syntax.
 */
const TOKEN_SHAPES: readonly RegExp[] = [
	/\bgh[pousr]_[A-Za-z0-9]{16,}/g,
	/\bgithub_pat_[A-Za-z0-9_]{20,}/g,
	/\bsk-[A-Za-z0-9_-]{16,}/g,
	/\bsk_(?:live|test)_[A-Za-z0-9]{8,}/g,
	/\b[rp]k_(?:live|test)_[A-Za-z0-9]{8,}/g,
	/\bAIza[0-9A-Za-z_-]{30,}/g,
	/\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{6,}/g,
	/\bxox[abposr]-[A-Za-z0-9-]{10,}/g,
	/\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/g,
	/\bglpat-[A-Za-z0-9_-]{16,}/g,
	/\bhf_[A-Za-z0-9]{20,}/g,
	/\bnpm_[A-Za-z0-9]{30,}/g,
	/\bpypi-[A-Za-z0-9_-]{30,}/g,
	/\bdop_v1_[a-f0-9]{40,}/g,
	/\bSG\.[A-Za-z0-9_-]{16,}\.[A-Za-z0-9_-]{16,}/g,
];
/** Authorization schemes followed by a token-shaped value. */
const AUTH_SCHEME = /\b(Bearer|Basic|Token)\s+[A-Za-z0-9._~+/=-]{8,}/gi;
/** Header names whose value is a credential. */
const SECRET_HEADER =
	/^(?:(?:proxy-)?authorization|cookie|x-[\w-]*(?:key|token|secret|auth)[\w-]*|[\w-]*api[-_]?key|private-token|[\w-]*-token)$/i;
/** Flag name segments that say the next value is a secret. */
const SECRET_FLAG_WORDS = new Set([
	"key",
	"apikey",
	"token",
	"secret",
	"password",
	"passwd",
	"pass",
	"pw",
	"auth",
	"authorization",
	"cred",
	"creds",
	"credential",
	"credentials",
	"pat",
]);
/** A URL with only plain URL characters: no shell or code syntax can sit inside it. */
const PLAIN_URL = /^(?:https?|wss?):\/\/[A-Za-z0-9._~%:@/?&=+,-]+$/i;

/** --token, --api-key, --client-secret, --auth (long flags only: a short flag says nothing). */
function isSecretFlag(flag: string): boolean {
	const m = /^--([A-Za-z][\w-]*)$/.exec(flag);
	if (!m) return false;
	return m[1]
		.toLowerCase()
		.split(/[-_]/)
		.some((w) => SECRET_FLAG_WORDS.has(w));
}

/** Mask known token shapes, plain-URL secrets and password userinfo; count each mask. */
function maskKnownShapes(text: string, count: { n: number }): string {
	const hit = (rep: string) => () => {
		count.n++;
		return rep;
	};
	let out = text.replace(/\b(?:https?|wss?):\/\/[^\s"'`]+/g, (m) => {
		if (!PLAIN_URL.test(m)) return m;
		const r = redactUrl(m);
		if (r !== m) count.n++;
		return r;
	});
	for (const re of TOKEN_SHAPES) out = out.replace(re, hit("***"));
	return out.replace(AUTH_SCHEME, (_m, scheme: string) => {
		count.n++;
		return `${scheme} ***`;
	});
}

/** A header value ("Name: value") with its value masked when the name is a credential header. */
function maskHeader(arg: string, count: { n: number }): string {
	const m = /^([\w-]+)(\s*:\s*)(.+)$/s.exec(arg);
	if (!m || !SECRET_HEADER.test(m[1])) return maskKnownShapes(arg, count);
	count.n++;
	return `${m[1]}${m[2]}***`;
}

/**
 * Redact a stdio server's argument list, allow-list style: a value is masked
 * only when it has a known secret shape (a known token prefix, the value after
 * a long flag named for a secret, a credential header after -H / --header, or
 * curl's -k / -K). Everything else, scripts and NAME=value pairs included, is
 * shown as is, so approve-mcp never hides code. `masked` counts the masks.
 */
export function redactStdio(
	args: readonly unknown[],
	command?: string,
): { args: string[]; masked: number } {
	// For HTTP clients (curl and the like) -k and -K are masked too: some take a
	// key there, and curl's -K names a config file that can hold credentials.
	const httpClient = command !== undefined && HTTP_CLIENTS.has(programName(command));
	const count = { n: 0 };
	const out: string[] = [];
	for (let i = 0; i < args.length; i++) {
		const arg = String(args[i]);
		const prev = i > 0 ? String(args[i - 1]) : "";
		const inline = /^(--[A-Za-z][\w-]*)=(.*)$/s.exec(arg);
		if (isSecretFlag(prev) || (httpClient && /^-[kK]$/.test(prev))) {
			count.n++;
			out.push("***");
		} else if (HEADER_FLAG.test(prev)) out.push(maskHeader(arg, count));
		else if (inline && isSecretFlag(inline[1])) {
			count.n++;
			out.push(`${inline[1]}=***`);
		} else if (/^--header=/.test(arg)) out.push(`--header=${maskHeader(arg.slice(9), count)}`);
		else out.push(maskKnownShapes(arg, count));
	}
	return { args: out, masked: count.n };
}

/** redactStdio without the count. */
export function redactArgs(args: readonly unknown[], command?: string): string[] {
	return redactStdio(args, command).args;
}

/** The program a server runs, by name only: env assignments skipped, no path, no args. */
function programName(command: string): string {
	const first = command
		.trim()
		.split(/\s+/)
		.find((t) => !/^[A-Za-z_][\w]*=/.test(t));
	return first ? path.basename(first.replace(/^["']|["']$/g, "")) : "(none)";
}

/** C0, DEL and C1 control characters: any of them can rewrite or hide what a terminal shows. */
const CONTROL_CHAR = /[\u0000-\u001f\u007f-\u009f]/;
/** Characters JSON.stringify leaves raw that still change how a line reads: DEL, C1, bidi and zero-width marks. */
const INVISIBLE = /[\u007f-\u009f\u200b-\u200f\u2028\u2029\u202a-\u202e\u2066-\u2069\ufeff]/g;
const ENV_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;

/** A string as a JSON literal with every control and invisible character escaped: safe to print. */
export function quoted(value: unknown): string {
	return JSON.stringify(String(value)).replace(
		INVISIBLE,
		(c) => `\\u${c.charCodeAt(0).toString(16).padStart(4, "0")}`,
	);
}

/** quoted() without the surrounding quotes, for names and paths inside a line. */
function escaped(value: unknown): string {
	return quoted(value).slice(1, -1);
}

/**
 * Why a server cannot be imported or approved: an env name that is not a
 * plain NAME, or a control character in the name, command, args, URL,
 * header names or values, or env values. Undefined when it is fine.
 */
export function unsafeServer(name: string, e: McpEntry): string | undefined {
	const bad = (v: unknown) => CONTROL_CHAR.test(String(v));
	if (bad(name)) return `the server name ${quoted(name)} has a control character`;
	if (e.command !== undefined && bad(e.command))
		return `"command" has a control character: ${quoted(e.command)}`;
	const args = Array.isArray(e.args) ? e.args : [];
	for (let i = 0; i < args.length; i++)
		if (bad(args[i])) return `"args[${i}]" has a control character: ${quoted(args[i])}`;
	if (e.url !== undefined && bad(e.url)) return `"url" has a control character: ${quoted(e.url)}`;
	for (const [k, v] of Object.entries(e.headers ?? {})) {
		if (bad(k)) return `a header name has a control character: ${quoted(k)}`;
		if (bad(v)) return `header ${quoted(k)} has a control character in its value: ${quoted(v)}`;
	}
	for (const [k, v] of Object.entries(e.env ?? {})) {
		if (!ENV_NAME.test(k))
			return `env name ${quoted(k)} is not a plain NAME ([A-Za-z_][A-Za-z0-9_]*)`;
		if (bad(v)) return `env ${k} has a control character in its value: ${quoted(v)}`;
	}
	return undefined;
}

/** One line for the import summary: program name or URL host only, env key names only. */
function summarizeServer(e: McpEntry): string {
	if (e.url) {
		try {
			return `url ${escaped(new URL(e.url).host)}`;
		} catch {
			return "url (unparsable)";
		}
	}
	const envKeys = Object.keys(e.env ?? {});
	return `program ${escaped(programName(String(e.command)))}${envKeys.length ? `, env: ${envKeys.map(escaped).join(", ")} (values not shown)` : ""}`;
}

/** An env name that says its value is a secret: GITHUB_TOKEN, API_KEY, DB_PASSWORD, GH_PAT (PATH is not). */
function isSecretEnvName(name: string): boolean {
	return name
		.toLowerCase()
		.split(/[-_]/)
		.some((w) => SECRET_FLAG_WORDS.has(w));
}

/** Env as NAME=value pairs (JSON-quoted values), in the order the config gives them. */
function envPairs(env: Record<string, unknown> | undefined): string[] {
	return Object.entries(env ?? {}).map(([k, v]) => `${escaped(k)}=${quoted(v)}`);
}

/**
 * Env shown as NAME=value: env can run code (NODE_OPTIONS, BASH_ENV,
 * LD_PRELOAD and more), so every value is shown unless the name is
 * secret-named or the value has a known token shape. Empty values never mask.
 */
export function redactEnv(env: Record<string, unknown> | undefined): {
	pairs: string[];
	masked: number;
} {
	const count = { n: 0 };
	const pairs = Object.entries(env ?? {}).map(([k, v]) => {
		const value = String(v);
		if (value !== "" && isSecretEnvName(k)) {
			count.n++;
			return `${escaped(k)}="***"`;
		}
		return `${escaped(k)}=${quoted(maskKnownShapes(value, count))}`;
	});
	return { pairs, masked: count.n };
}

/**
 * A URL server's headers as Name: "value". A value is masked when the header
 * is a credential header (Authorization, X-Api-Key, Cookie and the like), its
 * name is secret-named, or the value has a known token shape. Empty values
 * never mask; each mask counts.
 */
export function redactHeaders(headers: Record<string, unknown> | undefined): {
	pairs: string[];
	masked: number;
} {
	const count = { n: 0 };
	const pairs = Object.entries(headers ?? {}).map(([k, v]) => {
		const value = String(v);
		if (value !== "" && (SECRET_HEADER.test(k) || isSecretEnvName(k))) {
			count.n++;
			return `${escaped(k)}: "***"`;
		}
		return `${escaped(k)}: ${quoted(maskKnownShapes(value, count))}`;
	});
	return { pairs, masked: count.n };
}

/**
 * What approve shows before it lets a server start: the full command or URL.
 * A stdio command keeps its code visible and masks only known secret shapes,
 * unless `showMasked` asks for every value as is. `masked` counts the masks.
 */
function fullServer(e: McpEntry, showMasked = false): { text: string; masked: number } {
	if (e.url) {
		const shownUrl = showMasked ? e.url : redact(e.url);
		const headers = showMasked
			? {
					pairs: Object.entries(e.headers ?? {}).map(([k, v]) => `${escaped(k)}: ${quoted(v)}`),
					masked: 0,
				}
			: redactHeaders(e.headers);
		const text = `url ${escaped(shownUrl)}${headers.pairs.length ? `; headers: ${headers.pairs.join(", ")}` : ""}`;
		return { text, masked: (shownUrl === e.url ? 0 : 1) + headers.masked };
	}
	const command = String(e.command ?? "");
	const raw = (e.args ?? []).map((a) => String(a));
	const shownCommand = showMasked ? { args: [command], masked: 0 } : redactStdio([command]);
	const shownArgs = showMasked ? { args: raw, masked: 0 } : redactStdio(raw, command);
	const args = shownArgs.args.map((a) => quoted(a));
	const shownEnv = showMasked ? { pairs: envPairs(e.env), masked: 0 } : redactEnv(e.env);
	const text = `command ${escaped(shownCommand.args[0])}${args.length ? ` ${args.join(" ")}` : ""}${shownEnv.pairs.length ? `; env: ${shownEnv.pairs.join(" ")}` : ""}`;
	return { text, masked: shownCommand.masked + shownArgs.masked + shownEnv.masked };
}

/**
 * The hash recorded for an imported server. Command and args are hashed as
 * they are, so two servers that differ anywhere (a hidden payload included)
 * never share a hash; imports.json holds only this digest, never the values.
 * Env values, the URL and header values are hashed as they are too (a
 * changed NODE_OPTIONS or Authorization is a new digest).
 */
function serverHash(e: McpEntry): string {
	const shape = {
		command: e.command !== undefined ? String(e.command) : undefined,
		args: (e.args ?? []).map((a) => String(a)),
		env: Object.entries(e.env ?? {})
			.map(([k, v]) => [k, String(v)])
			.sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)),
		url: e.url !== undefined ? String(e.url) : undefined,
		headers: Object.entries(e.headers ?? {})
			.map(([k, v]) => [k, String(v)])
			.sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)),
		type: e.type,
	};
	return sha(JSON.stringify(shape));
}

/** Write a file only its owner can read (the MCP config can hold secrets). */
function writePrivate(file: string, text: string): void {
	fs.mkdirSync(path.dirname(file), { recursive: true });
	// Tighten an existing file BEFORE the secrets go in; a new file is created 0600.
	if (fs.existsSync(file)) {
		try {
			fs.chmodSync(file, 0o600);
		} catch {
			/* Windows: ACLs, not modes */
		}
	}
	fs.writeFileSync(file, text, { mode: 0o600 });
}

function importMcp(
	paths: ImportPaths,
	from: string,
): { lines: string[]; records: ImportRecord[]; code: number } {
	const now = new Date().toISOString();
	const lines: string[] = [];
	const records: ImportRecord[] = [];
	let config: Record<string, unknown> = {};
	if (fs.existsSync(paths.mcpConfig)) {
		try {
			config = JSON.parse(fs.readFileSync(paths.mcpConfig, "utf8")) as Record<string, unknown>;
		} catch (err) {
			return {
				lines: [
					`${paths.mcpConfig} is not valid JSON (${(err as Error).message}); nothing imported.`,
				],
				records,
				code: 1,
			};
		}
	}
	const live = {
		...((config.servers as Record<string, unknown>) ?? {}),
		...((config.mcpServers as Record<string, unknown>) ?? {}),
	};
	const pending = { ...((config.pendingServers as Record<string, McpEntry>) ?? {}) };
	let found = 0;
	for (const src of mcpSources(paths, from)) {
		if (!fs.existsSync(src.file)) continue;
		let json: unknown;
		try {
			json = JSON.parse(fs.readFileSync(src.file, "utf8"));
		} catch {
			lines.push(`  ${src.label}: ${src.file} is not valid JSON; skipped`);
			continue;
		}
		for (const [name, entry] of Object.entries(src.pick(json))) {
			found++;
			if (!entry || (!entry.command && !entry.url)) {
				lines.push(`  ${escaped(name)}  failed  (${src.label}) has neither "command" nor "url"`);
				continue;
			}
			const unsafe = unsafeServer(name, entry);
			if (unsafe) {
				lines.push(`  ${escaped(name)}  failed  (${src.label}) ${unsafe}; not imported`);
				continue;
			}
			if (name in live) {
				lines.push(`  ${escaped(name)}  skipped  (${src.label}) already in ${paths.mcpConfig}`);
				continue;
			}
			if (name in pending) {
				// A re-import never replaces a pending server: the person may be reading it now.
				lines.push(
					`  ${escaped(name)}  skipped  (${src.label}) already pending approval; approve it or remove it from "pendingServers" first`,
				);
				continue;
			}
			const hash = serverHash(entry);
			pending[name] = {
				...entry,
				importedFrom: { source: src.label, path: src.file, sha256: hash, importedAt: now },
			};
			records.push({
				source: `mcp:${src.label}`,
				kind: "mcp",
				name,
				path: src.file,
				sha256: hash,
				importedAt: now,
				enabled: false,
			});
			lines.push(`  ${escaped(name)}  pending approval  (${src.label}) ${summarizeServer(entry)}`);
		}
	}
	if (found === 0) {
		return {
			lines: ["No MCP servers found in the Claude Code or Pi config files."],
			records,
			code: 0,
		};
	}
	config.pendingServers = pending;
	writePrivate(paths.mcpConfig, `${JSON.stringify(config, null, 2)}\n`);
	return {
		lines: [
			`MCP servers (written to "pendingServers" in ${paths.mcpConfig}; none starts until you approve it):`,
			...lines,
			"See exactly what one runs, then approve it: 8gent ext approve-mcp <name>, then add --yes",
		],
		records,
		code: 0,
	};
}

/**
 * Approve one pending MCP server. Without `confirm` it only shows what would
 * run (full command and args, known secret shapes masked, and the file it
 * came from); with `confirm` (`--yes`) it moves the server into the live list.
 * When anything is masked, `--yes` is refused unless `showMasked`
 * (`--show-masked`) printed every value as is. Never starts it.
 */
export function approveMcp(
	name: string,
	paths: Pick<ImportPaths, "mcpConfig">,
	confirm = false,
	showMasked = false,
): { code: number; output: string } {
	if (!fs.existsSync(paths.mcpConfig)) return { code: 1, output: `No ${paths.mcpConfig}.` };
	const config = JSON.parse(fs.readFileSync(paths.mcpConfig, "utf8")) as Record<
		string,
		Record<string, McpEntry> | undefined
	>;
	const pending = config.pendingServers ?? {};
	const entry = pending[name];
	if (!entry) {
		const names = Object.keys(pending);
		return {
			code: 1,
			output: `No pending MCP server ${quoted(name)}.${names.length ? ` Pending: ${names.map(escaped).join(", ")}` : ""}`,
		};
	}
	const { importedFrom, ...server } = entry as McpEntry & {
		importedFrom?: { path?: string; source?: string };
	};
	const unsafe = unsafeServer(name, server);
	if (unsafe) {
		return {
			code: 1,
			output: `Refused: MCP server ${quoted(name)} cannot be approved: ${unsafe}. Fix or remove it in ${paths.mcpConfig}.`,
		};
	}
	const full = fullServer(server, showMasked);
	const shown = [
		`  ${full.text}`,
		`  from ${escaped(importedFrom?.source ?? "unknown source")}: ${escaped(importedFrom?.path ?? "unknown file")}`,
	];
	const maskedNote =
		full.masked > 0
			? [
					`  ${full.masked} ${full.masked === 1 ? "value" : "values"} masked (shown as ***). See every value before approving: 8gent ext approve-mcp ${escaped(name)} --show-masked`,
				]
			: [];
	if (!confirm) {
		return {
			code: 0,
			output: [
				`MCP server ${quoted(name)} would run:`,
				...shown,
				...maskedNote,
				full.masked > 0
					? `Nothing changed. If that is what you expect: 8gent ext approve-mcp ${escaped(name)} --show-masked --yes`
					: `Nothing changed. If that is what you expect: 8gent ext approve-mcp ${escaped(name)} --yes`,
			].join("\n"),
		};
	}
	if (full.masked > 0) {
		return {
			code: 1,
			output: [
				`Refused: MCP server ${quoted(name)} has masked values, so you would approve something you have not seen:`,
				...shown,
				...maskedNote,
				`To approve it, look at every value first: 8gent ext approve-mcp ${escaped(name)} --show-masked --yes`,
			].join("\n"),
		};
	}
	const key = config.servers ? "servers" : config.mcpServers ? "mcpServers" : "servers";
	config[key] = { ...(config[key] ?? {}), [name]: server };
	delete pending[name];
	config.pendingServers = pending;
	writePrivate(paths.mcpConfig, `${JSON.stringify(config, null, 2)}\n`);
	return {
		code: 0,
		output: [
			`Approved MCP server ${quoted(name)}. It starts the next time 8gent starts and runs:`,
			...shown,
		].join("\n"),
	};
}

// ── entry ────────────────────────────────────────────────────────────────────

/** Why a source cannot be imported, naming what is missing. */
function unknownSource(source: string): string {
	const looksLikePath =
		source.includes("/") || source.includes("\\") || /\.(ts|js|json|md)$/.test(source);
	const lines = [
		`8gent cannot import "${source}": no importer reads its format, so nothing was imported.`,
	];
	if (looksLikePath) {
		lines.push(
			"  A path is only read as a Pi extensions folder: 8gent ext import pi <path>.",
			"  Other extension formats need their host's API (for example a different tools/commands/events object) that 8gent does not provide;",
			"  8gent does not guess or machine-translate them.",
		);
	}
	lines.push(`  Supported sources: ${SUPPORTED_SOURCES.join(", ")}.`);
	return lines.join("\n");
}

export interface ImportOptions {
	paths?: Partial<ImportPaths>;
	env?: NodeJS.ProcessEnv;
}

/** `8gent ext import <source> [--from claude-code|pi] [--enable]` for claude-code, mcp and unknown sources. */
export function importFromSource(
	source: string,
	flags: { from?: string; enable?: boolean },
	opts: ImportOptions = {},
): { code: number; output: string } {
	const paths: ImportPaths = { ...defaultImportPaths(opts.env), ...opts.paths };
	if (source === "claude-code") {
		const { lines, records } = importClaudeCode(paths, flags.enable === true);
		recordImports(paths.eightDir, records);
		lines.push(`Sources and sha256 are recorded in ${path.join(paths.eightDir, "imports.json")}.`);
		return { code: 0, output: lines.join("\n") };
	}
	if (source === "mcp") {
		const from = flags.from ?? "all";
		if (!["all", "claude-code", "pi"].includes(from)) {
			return { code: 1, output: `--from must be claude-code or pi (got "${from}").` };
		}
		const { lines, records, code } = importMcp(paths, from);
		recordImports(paths.eightDir, records);
		return { code, output: lines.join("\n") };
	}
	return { code: 1, output: unknownSource(source) };
}
