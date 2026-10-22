/**
 * Pre-spawn backstops for run_command, shared by both tool paths (#3993).
 *
 * The text path (ToolExecutor.runCommand) and the native path (packages/ai
 * runShellCommand) must refuse the same commands with the same words. Before
 * this module the native path had none of these four, so it listed
 * ~/.8gent/browser-profiles where the text path refused.
 *
 * These are speed bumps, not the boundary: the boundary is seatbelting
 * run_command (#3612). Each check runs before any permission card, System One
 * or spawn.
 */

import { renderCoverageRefusal } from "../ai/narration-coverage";
import { touchesBrowserSecrets } from "../tools/eight-browser";
import {
	commandMutatesSessionRecords,
	commandTouchesAuditFiles,
	commandWritesStartupCode,
} from "./path-guard";
import { refusalLead } from "./refusal-lead";

/**
 * The refusal for `command`, or null when none of the backstops applies. `cwd` is the
 * directory the command runs in, so relative paths and `cd` resolve as the shell will.
 */
export function preSpawnRefusal(command: string, cwd: string = process.cwd()): string | null {
	const refusal = backstopRefusal(command, cwd);
	// One lead for every backstop, on both tool paths: the model reads the first sentence (#4238).
	return refusal === null ? null : refusalLead(refusal);
}

/**
 * A run that starts another 8gent nests a second one inside the first (#4715). Rule: split the
 * command on whitespace and shell operators, strip quotes and backslashes from every token (the
 * shell does), and refuse if ANY token names the 8gent binary. Position does not matter, so
 * wrappers (env, sudo, timeout, setsid, doas...), keywords (if, for, while, !), eval, backticks
 * and `sh -c '...'` are covered by construction. The names are package.json "bin": `8`, `8gent`,
 * `8gent-code`, all pointing at bin/8gent-run.js, plus bin/8gent.ts. `node dist/cli.js` is the
 * built entry and counts when a chat, run or mcp-server word is also present.
 *
 * Refused by design: `grep '8gent chat' x` and `echo 8gent` also trip it. This is a backstop,
 * not the boundary: the runtime guard (permissions/nested-guard.ts, EIGHT_PARENT_SESSION in the
 * tool shell env, checked by bin/8gent-run.js and bin/8gent.ts) closes what text cannot see.
 */
const BIN_NAMES = new Set(["8gent", "8gent-code", "8gent-run", "8gent-run.js", "8gent.ts"]);
/** A path to the binary: `/x/8gent`, `bin/8gent-run.js`, `.bin/8gent`. A folder named 8gent-code is not one. */
const BIN_PATH_ENDS = ["/8gent", "/8gent-run", "/8gent-run.js", "/8gent.ts"];
const PACKAGE = "@8gi-foundation/8gent-code";
const SUBCOMMANDS = new Set(["chat", "run", "mcp-server"]);
/** The only commands naming 8gent that are information, accepted only as the whole command. */
const INFO_FORMS = new Set(["which 8gent", "command -v 8gent", "8gent --version", "8gent --help"]);

function commandTokens(command: string): string[] {
	return command
		.replace(/['"\\]/g, "")
		.split(/[\s;&|(){}`<>]+/)
		.filter(Boolean);
}

/** Words that run the next word as a command (or open a clause), so the next word is in command position. */
const WRAPPERS = new Set([
	"env",
	"nohup",
	"exec",
	"time",
	"command",
	"sudo",
	"doas",
	"xargs",
	"timeout",
	"nice",
	"stdbuf",
	"setsid",
	"caffeinate",
	"eval",
	"script",
	"!",
	"if",
	"then",
	"elif",
	"else",
	"do",
	"while",
	"until",
]);

/** Per segment (split on operators and newlines): the tokens, and which of them are in command position. */
function segments(command: string): { tokens: string[]; position: boolean[] }[] {
	return command
		.replace(/['"\\]/g, "")
		.split(/[;&|(){}`\n]+/)
		.map((seg) => seg.split(/\s+|[<>]+/).filter(Boolean))
		.filter((t) => t.length > 0)
		.map((tokens) => {
			const position = tokens.map(() => false);
			for (let i = 0; i < tokens.length; i++) {
				position[i] = true;
				const t = tokens[i];
				// Skip over wrapper words, their flags and values, and VAR=x assignments.
				if (
					WRAPPERS.has(t) ||
					t.endsWith("/env") ||
					/^\w+=/.test(t) ||
					t.startsWith("-") ||
					/^\d/.test(t)
				)
					continue;
				// A flag value after a wrapper (sudo -u root, nice -n 5): keep scanning one more word.
				if (i > 0 && tokens[i - 1].startsWith("-") && !tokens[i - 1].includes("=")) continue;
				break;
			}
			return { tokens, position };
		});
}

const ENV_BAD_FLAG =
	/^(-|-[A-Za-z0-9]*[iSu][A-Za-z0-9]*|--ignore-environment|--split-string.*|--unset.*)$/;

export function spawnsSelf(command: string): boolean {
	if (INFO_FORMS.has(command.trim().replace(/\s+/g, " "))) return false;
	const tokens = commandTokens(command);
	// Naming the guard's own variables, or clearing the environment, is an attempt to get around
	// it. `env -i` plus indirection (`x=8g;y=ent; env -i $x$y chat`) is the residual a text rule
	// cannot see by name; refusing env -i, -S, -u, --unset, --ignore-environment and `unset` closes
	// it, even when the variable name is built by indirection. Flags are judged only on an `env`
	// in command position, so `grep -i env README.md` passes; `env --version`, `env -0` and
	// `env VAR=x cmd` stay allowed.
	if (
		tokens.some(
			(t) => t.includes("EIGHT_PARENT_SESSION") || t.includes("ALLOW_NESTED") || t === "unset",
		)
	)
		return true;
	const segs = segments(command);
	for (const { tokens: ts, position } of segs) {
		for (let i = 0; i < ts.length; i++) {
			if (!(ts[i] === "env" || ts[i].endsWith("/env")) || !position[i]) continue;
			for (let j = i + 1; j < ts.length && (ts[j].startsWith("-") || /^\w+=/.test(ts[j])); j++)
				if (ENV_BAD_FLAG.test(ts[j])) return true;
		}
	}
	// `8` and a path ending in /8 are the binary only as a command (`8 chat`, `~/.bun/bin/8 run`), not an argument (`head -n 8`).
	for (const { tokens: ts, position } of segs)
		for (let i = 0; i < ts.length; i++)
			if (
				(ts[i] === "8" || ts[i].endsWith("/8")) &&
				(position[i] || SUBCOMMANDS.has(ts[i + 1] ?? ""))
			)
				return true;
	const names8gent = (t: string) =>
		BIN_NAMES.has(t) || BIN_PATH_ENDS.some((e) => t.endsWith(e)) || t.startsWith(PACKAGE);
	if (tokens.some(names8gent)) return true;
	return (
		tokens.some((t) => t === "cli.js" || t.endsWith("/cli.js")) &&
		tokens.some((t) => SUBCOMMANDS.has(t))
	);
}

function backstopRefusal(command: string, cwd: string): string | null {
	if (spawnsSelf(command))
		return "[BLOCKED] You are already 8gent; use your tools. A run cannot start `8gent chat`, `8gent run` or `8gent mcp-server` from inside itself.";
	// #3595: the file that lists post_message recipients is not for the shell. A minimum,
	// not a parser: the allowlist is also frozen at process start.
	if (
		/\.8gent\S*\s*[/\\]+\s*settings/i.test(command) ||
		/\.8gent["']?\s*[/\\]["']?settings/i.test(command)
	)
		return `[PERMISSION DENIED] Command touches ~/.8gent/settings.json, which agent tools may not use: ${command}`;
	// #4594: the default Telegram bot key file. Same minimum as settings: the sandbox is the boundary.
	if (
		/\.8gent\S*\s*[/\\]+\s*secrets\b/i.test(command) ||
		/\.8gent["']?\s*[/\\]["']?secrets\b/i.test(command)
	)
		return `[PERMISSION DENIED] Command touches ~/.8gent/secrets, which agent tools may not use: ${command}`;
	// #3735: agent audit files; same check as the policy gate.
	if (commandTouchesAuditFiles(command))
		return `[PERMISSION DENIED] Command touches agent audit files, which agent tools may not use: ${command}`;
	// The session's own records are read-only to the shell.
	if (commandMutatesSessionRecords(command))
		return `[PERMISSION DENIED] Command would change session records, which agent tools may not do: ${command}`;
	// #3622 (8SO HIGH-2): the 8gent Browser control tokens and profile dirs.
	if (touchesBrowserSecrets(command))
		return `[PERMISSION DENIED] Run it without touching ~/.8gent/browser-* paths: this command reaches 8gent Browser control tokens or profiles, which tools may not use: ${command}`;
	// #4009 (8SO F2): hooks, extensions, prompts and packages run at start; read-only to the shell.
	if (commandWritesStartupCode(command, cwd))
		return `[PERMISSION DENIED] Command would change 8gent hooks, extensions, prompts or packages, which agent tools may not do: ${command}`;
	// #4154: not a security check. A slides video is not rendered while its
	// narration leaves out a slide's point; refused before any approval card.
	return renderCoverageRefusal(command, cwd);
}
