/**
 * Fires one PreToolUse YAML hook whose command never reads stdin, with a
 * payload far larger than a pipe buffer. Prints the fire result as JSON.
 * An unhandled EPIPE on the hook's stdin crashes this process instead.
 */
import { getHookManager } from "../../index";

const result = await getHookManager().fire("PreToolUse", {
	tool: "write_file",
	workingDirectory: process.cwd(),
	padding: "x".repeat(4 * 1024 * 1024),
});
process.stdout.write(JSON.stringify({ blocked: result.blocked, reason: result.reason }));
