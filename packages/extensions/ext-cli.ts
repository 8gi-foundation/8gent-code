/**
 * `8gent ext ...` and `/extensions ...`: extension housekeeping commands.
 *
 *   ext import-pi [path]   copy Pi extensions into ~/.8gent/extensions as pi-*,
 *                          record their sha256, and report each one as
 *                          loaded, partial (named missing APIs) or failed.
 *
 * Import copies local files only, fetches nothing and runs none of the
 * imported code: the report comes from reading the source (pi-compat.ts
 * analyzePiExtension). Imported extensions stay off until
 * `8gent ext enable <name>`, and their sha256 is checked on every load.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { defaultExtensionsDir } from "./host";
import {
	type ImportPaths,
	approveMcp,
	defaultImportPaths,
	importFromSource,
} from "./import-sources";
import {
	type PiStaticReport,
	analyzePiExtension,
	copyPiExtensions,
	defaultPiExtensionsDir,
	setImportedEnabled,
} from "./pi-compat";

export interface ExtCommandOptions {
	/** Destination; default ~/.8gent/extensions. */
	extensionsDir?: string;
	/**
	 * Is a person at a terminal? Default: stdin and stdout are both TTYs.
	 * Enabling an extension requires it, so a model running a shell command
	 * cannot turn one on.
	 */
	interactive?: boolean;
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
	"  Nothing imported runs until: 8gent ext enable <name>  (8gent ext disable <name> turns it off).",
	"       8gent ext import <pi|claude-code|mcp> [path] [--from claude-code|pi] [--enable]",
	"  pi: same as import-pi. claude-code: ~/.claude/commands become /claude-<name> prompt",
	"  templates (staged; --enable turns them on); ~/.claude/skills are already read in place.",
	"  mcp: MCP servers from Claude Code or Pi are added as pending; none starts until approved.",
	"       8gent ext approve-mcp <name> [--show-masked] [--yes]   shows what it runs; --yes approves",
	"       a server with masked values (***) is approved only with --show-masked --yes",
].join("\n");

/** The file the host loads for an imported entry: the file, or a folder's index. */
function entryFile(dest: string): string {
	if (/\.(ts|js|mjs|mts)$/.test(dest)) return dest;
	const index = ["index.ts", "index.js", "index.mjs"].find((i) =>
		fs.existsSync(path.join(dest, i)),
	);
	return path.join(dest, index ?? "index.ts");
}

function line(name: string, sha: string, r: PiStaticReport): string {
	const short = sha.slice(0, 12);
	const what = r.registers.length ? r.registers.join(", ") : "nothing found";
	if (r.status === "failed") return `  ${name}  failed   ${r.errors.join("; ")}  sha256 ${short}`;
	if (r.status === "partial") {
		return `  ${name}  partial  registers ${what}; not active in 8gent: ${r.missing.join(", ")}  sha256 ${short}`;
	}
	return `  ${name}  loaded   registers ${what}  sha256 ${short}`;
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
	let yes = false;
	let showMasked = false;
	for (let i = 0; i < raw.length; i++) {
		if (raw[i] === "--to" && raw[i + 1]) toFlag = path.resolve(raw[++i]);
		else if (raw[i] === "--from" && raw[i + 1]) fromFlag = raw[++i];
		else if (raw[i] === "--enable") enable = true;
		else if (raw[i] === "--yes") yes = true;
		else if (raw[i] === "--show-masked") showMasked = true;
		else rest.push(raw[i]);
	}
	if (sub === "enable" || sub === "disable") {
		if (!rest[0]) return { code: 1, output: `Usage: 8gent ext ${sub} <name>` };
		let dir: string;
		try {
			dir = toFlag ?? opts.extensionsDir ?? defaultExtensionsDir();
		} catch (err) {
			return { code: 1, output: (err as Error).message };
		}
		const interactive =
			opts.interactive ?? (Boolean(process.stdin.isTTY) && Boolean(process.stdout.isTTY));
		if (sub === "enable" && !interactive) {
			return {
				code: 1,
				output: `Refused: 8gent ext enable needs a person at an interactive terminal. Run it yourself in a terminal: 8gent ext enable ${rest[0]}`,
			};
		}
		return setImportedEnabled(dir, rest[0], sub === "enable");
	}
	if (sub === "approve-mcp") {
		if (!rest[0]) return { code: 1, output: "Usage: 8gent ext approve-mcp <name>" };
		const paths = { ...defaultImportPaths(opts.env), ...opts.paths };
		const interactive =
			opts.interactive ?? (Boolean(process.stdin.isTTY) && Boolean(process.stdout.isTTY));
		if (yes && !interactive) {
			return {
				code: 1,
				output: `Refused: approving an MCP server needs a person at an interactive terminal. Run it yourself: 8gent ext approve-mcp ${rest[0]} --yes`,
			};
		}
		return approveMcp(rest[0], paths, yes, showMasked);
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
	let copied: ReturnType<typeof copyPiExtensions>;
	try {
		copied = copyPiExtensions(from, to);
	} catch (err) {
		return { code: 1, output: (err as Error).message };
	}
	const { entries, refused } = copied;
	if (entries.length === 0 && refused.length === 0) {
		return {
			code: 0,
			output: `No Pi extensions (.ts/.js files or folders with an index) in ${from}.`,
		};
	}
	const lines = [
		`Imported ${entries.length} Pi extension(s) from ${from} into ${to} (none of their code was run):`,
	];
	let failed = 0;
	for (const e of entries) {
		const report = analyzePiExtension(entryFile(e.dest));
		if (report.status === "failed") failed++;
		lines.push(line(e.name, e.sha256, report));
	}
	for (const r of refused) {
		failed++;
		lines.push(`  ${r.name}  not imported  ${r.reason}`);
	}
	lines.push(
		"All of them are OFF. Turn one on with: 8gent ext enable <name> (its sha256 is checked on every load).",
		"Sources and sha256 are recorded in pi-imports.json. Enabled ones load in the interactive TUI (--no-extensions turns extensions off).",
	);
	return { code: failed > 0 ? 2 : 0, output: lines.join("\n") };
}
