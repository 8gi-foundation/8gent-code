/**
 * Where the owner's brought-home setup lives (#5037). Kept tiny and free of imports so the
 * skill loader can ask "has this owner imported?" without pulling in the scanner.
 */

import * as fs from "node:fs";
import * as path from "node:path";

/** ~/.8gent/imported: everything brought home from other tools. */
export function importedRoot(home: string): string {
	return path.join(home, ".8gent", "imported");
}

/** Written only by a consented import. Its presence is what "this owner has imported" means. */
export function importManifestPath(home: string): string {
	return path.join(importedRoot(home), "manifest.json");
}

/** True once an import has completed: 8gent then stops reading ~/.claude and ~/.agents live. */
export function hasImported(home: string): boolean {
	try {
		return fs.existsSync(importManifestPath(home));
	} catch {
		return false;
	}
}

/** Remembers that the owner was asked at first run, so the question is not repeated. */
export function askedMarkerPath(home: string): string {
	return path.join(home, ".8gent", "bring-it-home.json");
}
