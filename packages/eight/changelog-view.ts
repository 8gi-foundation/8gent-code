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

/** Join sections into display text. */
export function formatSections(sections: ChangelogSection[]): string {
	return sections.map((s) => s.body).join("\n\n");
}

/**
 * Read and parse the CHANGELOG shipped with this 8gent. `fromDir` is where the
 * upward search for the package root starts (default: this file's folder).
 * Returns [] when no changelog ships or it cannot be read; never throws.
 */
export function loadChangelog(fromDir: string = import.meta.dir): ChangelogSection[] {
	try {
		const p = bundledChangelogPath(fromDir);
		return p ? parseChangelog(readFileSync(p, "utf8")) : [];
	} catch {
		return [];
	}
}
