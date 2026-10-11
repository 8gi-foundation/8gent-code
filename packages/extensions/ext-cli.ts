/**
 * `8gent ext ...` and `/extensions ...`: extension housekeeping commands.
 *
 *   ext import-pi [path]   copy Pi extensions into ~/.8gent/extensions as pi-*,
 *                          record their sha256, and report each one as
 *                          loaded, partial (named missing APIs) or failed.
 *
 * Import copies local files only and fetches nothing. The status check loads
 * each imported extension once in an isolated host (its factory runs, as it
 * would on the next start); nothing is registered with a running session.
 * Imported extensions run when the session has extensions on, the default in
 * the interactive TUI and `8gent -p` (`--no-extensions` turns them off).
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { ExtensionHost, type ExtensionLoadResult, defaultExtensionsDir } from "./host";
import {
	type ImportPaths,
	approveMcp,
	defaultImportPaths,
	importFromSource,
} from "./import-sources";
import { copyPiExtensions, defaultPiExtensionsDir } from "./pi-compat";

export interface ExtCommandOptions {
	/** Destination; default ~/.8gent/extensions. */
	extensionsDir?: string;
	env?: NodeJS.ProcessEnv;
	/** Overrides for the other import sources' paths (tests). */
	paths?: Partial<ImportPaths>;
}

export interface ExtCommandResult {
	code: number;
	output: string;
}

const USAGE = [
	"Usage: 8gent ext import-pi [path] [--to <dir>]",
	"  Copies Pi extensions into ~/.8gent/extensions as pi-<name> and checks each one.",
	"  path defaults to $PI_CODING_AGENT_DIR/extensions or ~/.pi/agent/extensions.",
	"       8gent ext import <pi|claude-code|mcp> [path] [--from claude-code|pi] [--enable]",
	"  pi: same as import-pi. claude-code: ~/.claude/commands become /claude-<name> prompt",
	"  templates (staged; --enable turns them on); ~/.claude/skills are already read in place.",
	"  mcp: MCP servers from Claude Code or Pi are added as pending; none starts until approved.",
	"       8gent ext approve-mcp <name>",
].join("\n");

/** A host that loads only the given files, to check them in isolation. */
class OnlyHost extends ExtensionHost {
	constructor(
		dir: string,
		private readonly only: Set<string>,
	) {
		super(dir);
	}
	override files(): string[] {
		return super.files().filter((f) => this.only.has(path.resolve(f)));
	}
}

/** The file the host loads for an imported entry: the file, or a folder's index. */
function entryFile(dest: string): string {
	if (/\.(ts|js|mjs|mts)$/.test(dest)) return dest;
	const index = ["index.ts", "index.js", "index.mjs"].find((i) =>
		fs.existsSync(path.join(dest, i)),
	);
	return path.join(dest, index ?? "index.ts");
}

function realOf(p: string): string {
	try {
		return fs.realpathSync(p);
	} catch {
		return path.resolve(p);
	}
}

function line(name: string, sha: string, r: ExtensionLoadResult | undefined): string {
	const short = sha.slice(0, 12);
	if (!r) return `  ${name}  failed   not found after copy  sha256 ${short}`;
	const what = [
		r.tools.length ? `tools: ${r.tools.join(", ")}` : "",
		r.commands.length ? `commands: ${r.commands.map((c) => `/${c}`).join(", ")}` : "",
	]
		.filter(Boolean)
		.join("; ");
	if (r.status === "failed" || !r.ok) return `  ${name}  failed   ${r.error}  sha256 ${short}`;
	if (r.status === "partial") {
		return `  ${name}  partial  ${what}${what ? "; " : ""}not active in 8gent: ${(r.missing ?? []).join(", ")}  sha256 ${short}`;
	}
	return `  ${name}  loaded   ${what || "tool_call checks"}  sha256 ${short}`;
}

export async function runExtCommand(
	args: string[],
	opts: ExtCommandOptions = {},
): Promise<ExtCommandResult> {
	const [sub, ...raw] = args;
	// --to <dir> imports somewhere other than ~/.8gent/extensions.
	const rest: string[] = [];
	let toFlag: string | undefined;
	let fromFlag: string | undefined;
	let enable = false;
	for (let i = 0; i < raw.length; i++) {
		if (raw[i] === "--to" && raw[i + 1]) toFlag = path.resolve(raw[++i]);
		else if (raw[i] === "--from" && raw[i + 1]) fromFlag = raw[++i];
		else if (raw[i] === "--enable") enable = true;
		else rest.push(raw[i]);
	}
	if (sub === "approve-mcp") {
		if (!rest[0]) return { code: 1, output: "Usage: 8gent ext approve-mcp <name>" };
		const paths = { ...defaultImportPaths(opts.env), ...opts.paths };
		return approveMcp(rest[0], paths);
	}
	if (sub === "import") {
		const [source, ...more] = rest;
		if (!source) return { code: 1, output: USAGE };
		if (source !== "pi") {
			return importFromSource(
				source,
				{ from: fromFlag, enable },
				{ paths: opts.paths, env: opts.env },
			);
		}
		rest.splice(0, rest.length, ...more);
	} else if (sub !== "import-pi") {
		return { code: sub ? 1 : 0, output: USAGE };
	}
	let from: string;
	let to: string;
	try {
		from = rest[0] ? path.resolve(rest[0]) : defaultPiExtensionsDir(opts.env);
		to = toFlag ?? opts.extensionsDir ?? defaultExtensionsDir();
	} catch (err) {
		return { code: 1, output: (err as Error).message };
	}
	let entries: ReturnType<typeof copyPiExtensions>;
	try {
		entries = copyPiExtensions(from, to);
	} catch (err) {
		return { code: 1, output: (err as Error).message };
	}
	if (entries.length === 0) {
		return {
			code: 0,
			output: `No Pi extensions (.ts/.js files or folders with an index) in ${from}.`,
		};
	}
	const host = new OnlyHost(to, new Set(entries.map((e) => path.resolve(entryFile(e.dest)))));
	const results = await host.load();
	const byFile = new Map(results.map((r) => [realOf(r.file), r]));
	const lines = [`Imported ${entries.length} Pi extension(s) from ${from} into ${to}:`];
	let failed = 0;
	for (const e of entries) {
		const r = byFile.get(realOf(entryFile(e.dest)));
		if (!r?.ok) failed++;
		lines.push(line(e.name, e.sha256, r));
	}
	lines.push(
		"Sources and sha256 are recorded in pi-imports.json. They run when extensions are on (the default in the TUI and 8gent -p; --no-extensions turns them off). Restart 8gent to pick them up.",
	);
	return { code: failed > 0 ? 2 : 0, output: lines.join("\n") };
}
