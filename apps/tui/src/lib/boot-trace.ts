/**
 * One-line boot trace (#4540). Best effort, never throws: a trace that can
 * break the first moment would defeat its purpose. Lines go to
 * ~/.8gent/boot-trace.log, and to stderr when 8GENT_BOOT_TRACE=1.
 */
import { appendFileSync, mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export function bootTrace(
	line: string,
	env: Record<string, string | undefined> = process.env,
): void {
	const text = `${new Date().toISOString()} boot ${line}\n`;
	try {
		if (env["8GENT_BOOT_TRACE"] === "1") process.stderr.write(text);
		const dir = join(homedir(), ".8gent");
		mkdirSync(dir, { recursive: true });
		appendFileSync(join(dir, "boot-trace.log"), text);
	} catch {
		// Tracing is optional.
	}
}
