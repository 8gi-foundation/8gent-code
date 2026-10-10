/**
 * Header row layout math for the top-of-frame HeaderBar.
 *
 * Pure functions, no React or Ink. The header is one row of chrome that
 * must never wrap: the brand pill on the left and the status cluster on
 * the right are fixed by their content, so the workspace segment in the
 * middle has to fit whatever columns remain. These helpers decide what
 * survives when it does not all fit.
 *
 * Priority inside the middle segment (highest first):
 *   1. the git branch name (up to BRANCH_MAX columns), or outside a
 *      repo the "no repo" note that stands in the branch's place
 *   2. a usable slice of the workspace path (at least PATH_MIN columns)
 *   3. the sync status ("in sync", "ahead 1")
 *   4. the rest of the path
 *
 * Every string returned here is already cut to size; the component only
 * has to render it with a truncating wrap as a last line of defence.
 */

/** Longest branch name the header will show before cutting the tail. */
export const BRANCH_MAX = 32;
/** Shortest path slice worth showing; below this the path is hidden. */
export const PATH_MIN = 12;
/** Longest sync label the header will show. */
export const SYNC_MAX = 11;
/** Width of " ⎇ " between the path and the branch. */
const PATH_BRANCH_GAP = 3;
/** Width of "⎇ " in front of the branch when the path is hidden. */
const BRANCH_GLYPH = 2;
/** Shortest branch slice worth showing on its own. */
const BRANCH_MIN = 4;

/**
 * Terminal cell width of a string. Counts code points and treats the
 * common East Asian wide and fullwidth blocks as two cells so a CJK
 * workspace path does not overflow the row. Combining marks count zero.
 */
export function cellWidth(value: string): number {
	let width = 0;
	for (const ch of value) {
		const cp = ch.codePointAt(0) ?? 0;
		if (cp === 0) continue;
		// Combining diacritics and zero-width joiners take no cell.
		if ((cp >= 0x0300 && cp <= 0x036f) || cp === 0x200b || cp === 0x200d || cp === 0xfe0f) continue;
		if (
			(cp >= 0x1100 && cp <= 0x115f) ||
			(cp >= 0x2e80 && cp <= 0xa4cf) ||
			(cp >= 0xac00 && cp <= 0xd7a3) ||
			(cp >= 0xf900 && cp <= 0xfaff) ||
			(cp >= 0xfe30 && cp <= 0xfe4f) ||
			(cp >= 0xff00 && cp <= 0xff60) ||
			(cp >= 0xffe0 && cp <= 0xffe6) ||
			(cp >= 0x1f300 && cp <= 0x1f64f) ||
			(cp >= 0x1f900 && cp <= 0x1f9ff) ||
			(cp >= 0x20000 && cp <= 0x3fffd)
		) {
			width += 2;
		} else {
			width += 1;
		}
	}
	return width;
}

/** Keep the head and tail of a string, replacing the middle with an ellipsis. */
export function truncateMiddle(value: string, max: number): string {
	if (max <= 0) return "";
	if (cellWidth(value) <= max) return value;
	if (max === 1) return "…";
	const chars = [...value];
	const keep = max - 1;
	const head = Math.ceil(keep / 2);
	const tail = keep - head;
	return `${chars.slice(0, head).join("")}…${tail > 0 ? chars.slice(chars.length - tail).join("") : ""}`;
}

/** Head kept by truncatePath: enough to recognise the root ("~/.8gent/ris"). */
export const PATH_HEAD = 12;

/**
 * Shorten a filesystem path for the header. What identifies a workdir is
 * its end (run id, scenario or project name, leaf directory), not its
 * root, so the head is held at PATH_HEAD columns and the tail gets the
 * rest. The even split of truncateMiddle cut a 30-character leaf name
 * back to a few characters of the run id (issue #3810).
 */
export function truncatePath(value: string, max: number): string {
	if (max <= 0) return "";
	if (cellWidth(value) <= max) return value;
	if (max === 1) return "…";
	const chars = [...value];
	const keep = max - 1;
	const head = Math.min(PATH_HEAD, Math.ceil(keep / 2));
	const tail = keep - head;
	return `${chars.slice(0, head).join("")}…${tail > 0 ? chars.slice(chars.length - tail).join("") : ""}`;
}

/** Keep the head of a string, replacing the tail with an ellipsis. */
export function truncateEnd(value: string, max: number): string {
	if (max <= 0) return "";
	if (cellWidth(value) <= max) return value;
	if (max === 1) return "…";
	return `${[...value].slice(0, max - 1).join("")}…`;
}

export interface HeaderMiddle {
	/** Workspace path slice, or "" when there is no room for a useful one. */
	path: string;
	/** Branch name, possibly cut at the tail, or "" when nothing fits. */
	branch: string;
	/** Sync label, or "" when it was dropped to make room. */
	sync: string;
}

/**
 * Fit the workspace segment into `available` columns.
 *
 * The returned strings are ready to render as
 * `path + " ⎇ " + branch + " " + sync`, with each separator omitted when
 * the neighbouring string is empty. See `headerMiddleWidth` for the exact
 * rendered width.
 */
export function fitHeaderMiddle(
	workspacePath: string,
	branchName: string,
	syncStatus: string,
	available: number,
): HeaderMiddle {
	const empty: HeaderMiddle = { path: "", branch: "", sync: "" };
	if (available <= 0) return empty;

	const branch = truncateEnd(branchName, BRANCH_MAX);
	const sync = truncateEnd(syncStatus, SYNC_MAX);
	const path = workspacePath;
	const branchW = cellWidth(branch);
	const syncW = cellWidth(sync);
	const syncCost = sync ? 1 + syncW : 0;

	// No branch: the path and the note ("no repo") only, never a "⎇ -".
	if (!branch) {
		const noteCost = sync ? (path ? 1 : 0) + syncW : 0;
		if (cellWidth(path) + noteCost <= available) return { path, branch: "", sync };
		if (path && available - noteCost >= PATH_MIN) {
			return { path: truncatePath(path, available - noteCost), branch: "", sync };
		}
		// The note holds the branch's slot, so like a branch it outranks a
		// path too short to read: 80 columns shows "no repo", not
		// "/Users/j…/work".
		if (sync && syncW <= available) return { path: "", branch: "", sync };
		if (path && available >= PATH_MIN) return { path: truncatePath(path, available), branch: "", sync: "" };
		return empty;
	}

	// 1. Everything as-is.
	if (cellWidth(path) + PATH_BRANCH_GAP + branchW + syncCost <= available) {
		return { path, branch, sync };
	}

	// 2. Full branch, full sync, path cut in the middle.
	let pathRoom = available - PATH_BRANCH_GAP - branchW - syncCost;
	if (path && pathRoom >= PATH_MIN) {
		return { path: truncatePath(path, pathRoom), branch, sync };
	}

	// 3. Full branch, sync dropped, path cut in the middle.
	pathRoom = available - PATH_BRANCH_GAP - branchW;
	if (path && pathRoom >= PATH_MIN) {
		return { path: truncatePath(path, pathRoom), branch, sync: "" };
	}

	// 4. Path hidden. Keep the full branch, and the sync label if it fits.
	if (BRANCH_GLYPH + branchW + syncCost <= available) {
		return { path: "", branch, sync };
	}
	if (BRANCH_GLYPH + branchW <= available) {
		return { path: "", branch, sync: "" };
	}

	// 5. Only a slice of the branch fits.
	const branchRoom = available - BRANCH_GLYPH;
	if (branchRoom >= BRANCH_MIN) {
		return { path: "", branch: truncateEnd(branch, branchRoom), sync: "" };
	}
	return empty;
}

/** Rendered width of a fitted middle segment, separators included. */
export function headerMiddleWidth(middle: HeaderMiddle): number {
	if (!middle.branch) {
		const pathW = cellWidth(middle.path);
		return pathW + (middle.sync ? (pathW ? 1 : 0) + cellWidth(middle.sync) : 0);
	}
	const pathPart = middle.path ? cellWidth(middle.path) + PATH_BRANCH_GAP : BRANCH_GLYPH;
	const syncPart = middle.sync ? 1 + cellWidth(middle.sync) : 0;
	return pathPart + cellWidth(middle.branch) + syncPart;
}
