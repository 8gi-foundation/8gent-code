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
 * `8gent chat`, `8gent run` or `8gent mcp-server` (also `bun bin/8gent.ts ...`, `node dist/cli.js ...`,
 * `npx @8gi-foundation/8gent-code ...`) at the start of
 * a command part. A run that spawns itself nests a second 8gent inside the first (#4715).
 * Anchored to a command position, so `grep "8gent chat"` and `echo 8gent run` are not matched.
 */
const SELF_SPAWN =
	/(?:^|[;&|(\n])\s*(?:\w+=\S*\s+)*(?:(?:(?:bun|bunx|node|npx|tsx)(?:\s+-\S+)*(?:\s+run)?\s+)?(?:\S*\/)?8gent(?:-code|-run)?(?:\.[tj]s)?|(?:bun|node|tsx)(?:\s+-\S+)*\s+(?:\S*\/)?cli\.js)(?:\s+-\S+)*\s+(?:chat|run|mcp-server)(?![\w-])/;

export function spawnsSelf(command: string): boolean {
	return SELF_SPAWN.test(command);
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
