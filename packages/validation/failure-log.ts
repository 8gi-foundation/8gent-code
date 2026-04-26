/**
 * 8gent Code - Failure Log
 *
 * Append-only JSONL log of what failed and how it was resolved.
 * Used by the healer to avoid repeating the same mistakes.
 */

import * as fs from "fs";
import * as os from "os";
import * as path from "path";

export interface FailureEntry {
	timestamp: string;
	action: string; // Short description of what was attempted
	error: string; // Error message or output
	resolution: string; // "reverted" | "succeeded on attempt N" | custom
	checkpointId: string;
	attempts: number;
}

const LOG_DIR = path.join(os.homedir(), ".8gent", "healing");
const LOG_FILE = path.join(LOG_DIR, "failures.jsonl");

function ensureLogDir(): void {
	if (!fs.existsSync(LOG_DIR)) {
		fs.mkdirSync(LOG_DIR, { recursive: true });
	}
}

/**
 * Append a failure entry to the log.
 */
export function logFailure(entry: FailureEntry): void {
	ensureLogDir();
	const line = JSON.stringify(entry) + "\n";
	fs.appendFileSync(LOG_FILE, line, "utf-8");
}

/**
 * Read all failure entries from the log.
 */
export function readFailures(): FailureEntry[] {
	if (!fs.existsSync(LOG_FILE)) return [];

	return fs
		.readFileSync(LOG_FILE, "utf-8")
		.split("\n")
		.filter(Boolean)
		.map((line) => {
			try {
				return JSON.parse(line) as FailureEntry;
			} catch {
				return null;
			}
		})
		.filter(Boolean) as FailureEntry[];
}

/**
 * Check if a similar action has failed before.
 * Returns the most recent matching failure, if any.
 */
export function findPriorFailure(action: string): FailureEntry | null {
	const failures = readFailures();
	// Match on action prefix (first 60 chars) to catch similar attempts
	const key = action.slice(0, 60).toLowerCase();
	return (
		failures
			.filter((f) => f.action.slice(0, 60).toLowerCase() === key)
			.sort((a, b) => b.timestamp.localeCompare(a.timestamp))[0] ?? null
	);
}
