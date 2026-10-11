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

import { touchesBrowserSecrets } from "../tools/eight-browser";
import { commandMutatesSessionRecords, commandTouchesAuditFiles } from "./path-guard";

/** The refusal for `command`, or null when none of the backstops applies. */
export function preSpawnRefusal(command: string): string | null {
	// #3595: the file that lists post_message recipients is not for the shell. A minimum,
	// not a parser: the allowlist is also frozen at process start.
	if (
		/\.8gent\S*\s*[/\\]+\s*settings/i.test(command) ||
		/\.8gent["']?\s*[/\\]["']?settings/i.test(command)
	)
		return `[PERMISSION DENIED] Command touches ~/.8gent/settings.json, which agent tools may not use: ${command}`;
	// #3735: agent audit files; same check as the policy gate.
	if (commandTouchesAuditFiles(command))
		return `[PERMISSION DENIED] Command touches agent audit files, which agent tools may not use: ${command}`;
	// The session's own records are read-only to the shell.
	if (commandMutatesSessionRecords(command))
		return `[PERMISSION DENIED] Command would change session records, which agent tools may not do: ${command}`;
	// #3622 (8SO HIGH-2): the 8gent Browser control tokens and profile dirs.
	if (touchesBrowserSecrets(command))
		return `[PERMISSION DENIED] Command touches 8gent Browser control tokens or profiles, which agent tools may not use: ${command}`;
	return null;
}
