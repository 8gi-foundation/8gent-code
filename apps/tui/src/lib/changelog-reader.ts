/**
 * Pure reader for CHANGELOG.md (#164). Takes the file text, never touches the
 * disk or the network. Headings look like `## [0.20.42] - 2026-10-27`.
 * Every line returned is a line of the file; the only text written here is
 * the one-line not-found and missing-file notices.
 */

const VERSION_HEADING = /^## \[(\d[^\]]*)\]/;

function toLines(text: string): string[] {
	return text.split(/\r?\n/);
}

/** `v0.20.45` and `0.20.45` are the same version. */
export function normalizeVersion(version: string): string {
	return version.trim().replace(/^v/i, "");
}

/** Version headings in file order (newest first as the file is written). [Unreleased] is not a version. */
export function listChangelogHeadings(text: string): string[] {
	return toLines(text).filter((line) => VERSION_HEADING.test(line));
}

/** The section for one version, heading line included, or null when the file has none. */
export function readChangelogSection(text: string, version: string): string | null {
	const wanted = normalizeVersion(version);
	const lines = toLines(text);
	const start = lines.findIndex((line) => VERSION_HEADING.exec(line)?.[1] === wanted);
	if (start === -1) return null;
	let end = lines.length;
	for (let i = start + 1; i < lines.length; i++) {
		if (lines[i].startsWith("## ")) {
			end = i;
			break;
		}
	}
	const body = lines.slice(start, end);
	while (body.length > 1 && (body[body.length - 1].trim() === "" || body[body.length - 1].trim() === "---")) {
		body.pop();
	}
	return body.join("\n");
}

/**
 * What `/changelog [arg]` prints. `text` is null when the file could not be
 * read. No argument means the installed version.
 */
export function changelogOutput(text: string | null, arg: string | undefined, installed: string): string {
	if (text === null) return "No changelog file found.";
	const asked = arg?.trim() ?? "";
	if (asked.toLowerCase() === "all") {
		const headings = listChangelogHeadings(text);
		return headings.length > 0 ? headings.join("\n") : "No version headings in the changelog.";
	}
	const version = normalizeVersion(asked === "" ? installed : asked);
	return readChangelogSection(text, version) ?? `No changelog entry for v${version}.`;
}
