/**
 * When the launch splash shows.
 *
 * The splash is a first impression, not a daily toll: it shows on the first
 * run and once after each update, then never again until the next version.
 * The last version that showed it is kept in ~/.8gent/intro-seen.
 *
 * Precedence:
 * - performance.introBanner "off" never shows it; "on" always shows it.
 * - 8GENT_NO_INTRO=1 or 8GENT_LITE=1 skip it.
 * - Otherwise it shows when this version has not shown it yet.
 */

import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { resolveHome } from "../../../../packages/core/home.js";

export type IntroSetting = "on" | "off" | "auto" | undefined;

export interface IntroGateInput {
	setting: IntroSetting;
	env: Record<string, string | undefined>;
	/** The version recorded the last time the splash showed, or null. */
	seenVersion: string | null;
	version: string;
}

export function shouldShowIntro({ setting, env, seenVersion, version }: IntroGateInput): boolean {
	if (setting === "off") return false;
	if (setting === "on") return true;
	if (env["8GENT_NO_INTRO"] === "1" || env["8GENT_LITE"] === "1") return false;
	return seenVersion !== version;
}

function seenPath(home: string): string {
	return join(home, ".8gent", "intro-seen");
}

export function readSeenVersion(home: string = resolveHome()): string | null {
	try {
		const v = readFileSync(seenPath(home), "utf-8").trim();
		return v || null;
	} catch {
		return null;
	}
}

/** Record that this version has shown the splash. Best-effort. */
export function markIntroSeen(version: string, home: string = resolveHome()): void {
	try {
		mkdirSync(join(home, ".8gent"), { recursive: true });
		writeFileSync(seenPath(home), `${version}\n`);
	} catch {
		// A read-only home only means the splash may show again next launch.
	}
}
