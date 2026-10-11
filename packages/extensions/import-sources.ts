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
import * as os from "node:os";
import * as path from "node:path";
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
	const home = os.homedir();
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
	fs.mkdirSync(eightDir, { recursive: true });
	fs.writeFileSync(file, `${JSON.stringify([...byKey.values()], null, 2)}\n`);
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

/** Claude Code command features our prompt templates do not run, named for the report. */
function claudeCommandGaps(text: string): string[] {
	const gaps: string[] = [];
	const fm = text.replace(/\r\n/g, "\n").match(/^---\n([\s\S]*?)\n---/)?.[1] ?? "";
	for (const key of ["allowed-tools", "model", "argument-hint", "disable-model-invocation"]) {
		if (new RegExp(`^${key}:`, "m").test(fm)) gaps.push(`frontmatter "${key}"`);
	}
	if (/^!`|[^`]!`[^`]+`/m.test(text)) gaps.push("!`command` shell output (stays as plain text)");
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
		fs.mkdirSync(staged, { recursive: true });
		fs.writeFileSync(path.join(staged, `${name}.md`), text);
		if (enable) {
			fs.mkdirSync(live, { recursive: true });
			fs.writeFileSync(path.join(live, `${name}.md`), text);
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

/** A short, secret-free description of a server for the report. */
function describeServer(e: McpEntry): string {
	if (e.url) {
		try {
			return `url ${new URL(e.url).origin}`;
		} catch {
			return "url (unparsable)";
		}
	}
	const envKeys = Object.keys(e.env ?? {});
	return `command ${e.command}${e.args?.length ? ` (+${e.args.length} args)` : ""}${envKeys.length ? `, env: ${envKeys.join(", ")} (values not shown)` : ""}`;
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
				lines.push(`  ${name}  failed  (${src.label}) has neither "command" nor "url"`);
				continue;
			}
			if (name in live) {
				lines.push(`  ${name}  skipped  (${src.label}) already in ${paths.mcpConfig}`);
				continue;
			}
			const canonical = JSON.stringify(entry, Object.keys(entry).sort());
			const hash = sha(canonical);
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
			lines.push(`  ${name}  pending approval  (${src.label}) ${describeServer(entry)}`);
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
	fs.mkdirSync(path.dirname(paths.mcpConfig), { recursive: true });
	fs.writeFileSync(paths.mcpConfig, `${JSON.stringify(config, null, 2)}\n`);
	return {
		lines: [
			`MCP servers (written to "pendingServers" in ${paths.mcpConfig}; none starts until you approve it):`,
			...lines,
			"Approve one with: 8gent ext approve-mcp <name>",
		],
		records,
		code: 0,
	};
}

/** Move one pending MCP server into the live list. Never starts it. */
export function approveMcp(
	name: string,
	paths: Pick<ImportPaths, "mcpConfig">,
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
			output: `No pending MCP server "${name}".${names.length ? ` Pending: ${names.join(", ")}` : ""}`,
		};
	}
	const { importedFrom: _from, ...server } = entry;
	const key = config.servers ? "servers" : config.mcpServers ? "mcpServers" : "servers";
	config[key] = { ...(config[key] ?? {}), [name]: server };
	delete pending[name];
	config.pendingServers = pending;
	fs.writeFileSync(paths.mcpConfig, `${JSON.stringify(config, null, 2)}\n`);
	return {
		code: 0,
		output: `Approved MCP server "${name}" (${describeServer(server)}). It starts the next time 8gent starts.`,
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
