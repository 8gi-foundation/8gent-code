/**
 * Yolo preference: the one yes gate for running tools without a card each turn.
 *
 * Yolo is the Infinite permission mode, held for the whole session (no 30
 * minute drop back to Ask) and remembered across runs. It removes the per-turn
 * confirmation cards and nothing else: the always-blocked list, the ask-every-time
 * list, the shell sanitizer, the secret and workspace guards all run exactly as
 * they do in Infinite. The TUI asks once; the answer, yes or no, lives in
 * ~/.8gent/yolo.json (or $EIGHT_DATA_DIR) and is never asked again.
 *
 * Only the TUI reads this. Headless -p and the daemon never do.
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

export type YoloChoice = "yes" | "no";

/** The file the answer lives in. Resolved per call so tests and EIGHT_DATA_DIR work. */
export function yoloPrefPath(dir?: string): string {
	return path.join(
		dir ?? process.env.EIGHT_DATA_DIR ?? path.join(os.homedir(), ".8gent"),
		"yolo.json",
	);
}

/** The saved answer, or undefined when never asked (or the file is unreadable: ask again). */
export function readYoloChoice(dir?: string): YoloChoice | undefined {
	try {
		const parsed = JSON.parse(fs.readFileSync(yoloPrefPath(dir), "utf8")) as { choice?: unknown };
		return parsed.choice === "yes" || parsed.choice === "no" ? parsed.choice : undefined;
	} catch {
		return undefined;
	}
}

/** Remember the answer. Returns false when it could not be written. */
export function writeYoloChoice(choice: YoloChoice, dir?: string): boolean {
	try {
		const file = yoloPrefPath(dir);
		fs.mkdirSync(path.dirname(file), { recursive: true });
		fs.writeFileSync(
			file,
			`${JSON.stringify({ choice, at: new Date().toISOString() }, null, 2)}\n`,
			{
				mode: 0o600,
			},
		);
		return true;
	} catch {
		return false;
	}
}

/** `/mode yolo` -> "on", `/mode yolo off` -> "off", anything else null. */
export function parseYoloArgs(args: readonly string[]): "on" | "off" | null {
	const words = args
		.flatMap((a) => a.trim().split(/\s+/))
		.filter(Boolean)
		.map((w) => w.toLowerCase());
	if (words[0] !== "yolo") return null;
	if (words.length === 1 || (words.length === 2 && words[1] === "on")) return "on";
	if (words.length === 2 && words[1] === "off") return "off";
	return null;
}

export const YOLO_QUESTION =
	"Enable yolo mode? Tools run without asking each time. Blocked commands stay blocked.";
