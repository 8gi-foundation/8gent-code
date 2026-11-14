/**
 * Changelog view (Pi parity row A5, data side).
 *
 * Pure parsing of the CHANGELOG that ships with this 8gent into version
 * sections, plus one loader. The path helper is self-update.ts's
 * bundledChangelogPath; it is imported, not copied. The /changelog command and
 * the "Updated to vX" notice are wired in the TUI by another lane.
 */

import { readFileSync } from "node:fs";
import { bundledChangelogPath, compareVersions } from "./self-update.js";

export interface ChangelogSection {
	version: string;
	/** Text after the version heading on the same line, e.g. "- 2026-10-01". */
	heading: string;
	/** Section text including its "## [X.Y.Z]" heading line, trimmed. */
	body: string;
}

/** Split markdown into "## [X.Y.Z]" sections, newest first. [Unreleased] and non-version headings are skipped. */
export function parseChangelog(markdown: string): ChangelogSection[] {
	const sections: ChangelogSection[] = [];
	let cur: { version: string; heading: string; lines: string[] } | null = null;
	const flush = () => {
		if (cur) sections.push({ version: cur.version, heading: cur.heading, body: cur.lines.join("\n").trim() });
		cur = null;
	};
	for (const line of markdown.split(/\r?\n/)) {
		const h = /^## \[(\d+\.\d+\.\d+)\](.*)$/.exec(line);
		if (h) {
			flush();
			cur = { version: h[1], heading: h[2].trim(), lines: [line] };
		} else if (line.startsWith("## ")) {
			flush();
		} else if (cur) {
			cur.lines.push(line);
		}
	}
	flush();
	return sections.sort((a, b) => compareVersions(b.version, a.version));
}

/** Sections strictly newer than `since`, newest first. A malformed `since` returns []. */
export function sectionsSince(sections: ChangelogSection[], since: string): ChangelogSection[] {
	try {
		return sections.filter((s) => compareVersions(s.version, since) > 0);
	} catch {
		return [];
	}
}

/** The newest `n` sections (n < 1 gives none). */
export function latestSections(sections: ChangelogSection[], n: number): ChangelogSection[] {
	return n >= 1 ? sections.slice(0, Math.floor(n)) : [];
}

/** Drop control characters (ESC, CSI, BEL, NUL, C1) so changelog text cannot drive the terminal. Keeps newline and tab. */
export function sanitizeForDisplay(text: string): string {
	return text
		.replace(/\x1b\[[0-?]*[ -\/]*[@-~]/g, "")
		.replace(/\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)?/g, "")
		.replace(/\r\n?/g, "\n")
		.replace(/[\x00-\x08\x0b-\x1f\x7f-\x9f]/g, "");
}

/** Join sections into display text, with control characters removed. */
export function formatSections(sections: ChangelogSection[]): string {
	return sanitizeForDisplay(sections.map((s) => s.body).join("\n\n"));
}

/**
 * The CHANGELOG text shipped with this 8gent: embedded in the compiled binary
 * when there is one, otherwise the CHANGELOG.md at the package root (see
 * bundledChangelogPath). `fromDir` is where the upward search for the package
 * root starts (default: this file's folder). Null when none ships or it cannot
 * be read; never throws.
 */
export function readBundledChangelog(fromDir: string = import.meta.dir): string | null {
	try {
		const p = bundledChangelogPath(fromDir);
		return p ? readFileSync(p, "utf8") : null;
	} catch {
		return null;
	}
}

/** Read and parse the CHANGELOG shipped with this 8gent. [] when none ships; never throws. */
export function loadChangelog(fromDir: string = import.meta.dir): ChangelogSection[] {
	const text = readBundledChangelog(fromDir);
	return text === null ? [] : parseChangelog(text);
}

/** `v0.20.45` and `0.20.45` are the same version. */
function normalizeVersion(version: string): string {
	return version.trim().replace(/^v/i, "");
}

/**
 * What `/changelog [arg]` prints. `text` is the changelog text, or null when
 * none ships. No argument means the installed version; `all` lists the version
 * headings. Versions match exactly, so 0.20.4 never matches 0.20.45. Every line
 * comes from the changelog except the two plain notices; control characters are
 * removed.
 */
export function changelogOutput(text: string | null, arg: string | undefined, installed: string): string {
	if (text === null) return "No changelog file found.";
	const sections = parseChangelog(text);
	const asked = arg?.trim() ?? "";
	if (asked.toLowerCase() === "all") {
		const headings = sections.map((s) => s.body.split("\n")[0]);
		return sanitizeForDisplay(headings.length > 0 ? headings.join("\n") : "No version headings in the changelog.");
	}
	const version = normalizeVersion(asked === "" ? installed : asked);
	const section = sections.find((s) => s.version === version);
	if (!section) return `No changelog entry for v${sanitizeForDisplay(version)}.`;
	const lines = section.body.split("\n");
	while (lines.length > 1 && ["", "---"].includes(lines[lines.length - 1].trim())) lines.pop();
	return sanitizeForDisplay(lines.join("\n"));
}
