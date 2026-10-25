/**
 * Per-tab context window (#5035).
 *
 * Each chat tab has its own window: what its provider's own models list
 * reported for the tab's model (detected), or what the owner typed in Settings
 * (override). The override is stored per tab id in ~/.8gent/tab-context-windows.json,
 * so it survives a restart, and it is what that tab's compaction uses.
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { type ContextWindow, MAX_PLAUSIBLE_WINDOW } from "./context-window.js";

export function overridesFile(): string {
	const dir = process.env.EIGHT_DATA_DIR?.trim() || path.join(os.homedir(), ".8gent");
	return path.join(dir, "tab-context-windows.json");
}

/** Tokens as typed: 128000, 128k, 1.5m. Null for anything that is not a plain size. */
export function parseWindowInput(raw: string): number | null {
	const m = /^\s*(\d+(?:\.\d+)?)\s*([km]?)\s*$/i.exec(raw);
	if (!m) return null;
	const mult = m[2]?.toLowerCase() === "m" ? 1_000_000 : m[2]?.toLowerCase() === "k" ? 1000 : 1;
	const n = Math.floor(Number(m[1]) * mult);
	return n >= 1 && n <= MAX_PLAUSIBLE_WINDOW ? n : null;
}

export function loadOverrides(file = overridesFile()): Record<string, number> {
	try {
		const json = JSON.parse(fs.readFileSync(file, "utf8")) as unknown;
		if (typeof json !== "object" || json === null || Array.isArray(json)) return {};
		const out: Record<string, number> = {};
		for (const [id, v] of Object.entries(json)) {
			if (typeof v === "number" && Number.isFinite(v) && v >= 1 && v <= MAX_PLAUSIBLE_WINDOW) {
				out[id] = Math.floor(v);
			}
		}
		return out;
	} catch {
		return {};
	}
}

/** Set (number) or clear (null) one tab's override and write the file. Returns the new map. */
export function saveOverride(
	tabId: string,
	tokens: number | null,
	file = overridesFile(),
): Record<string, number> {
	const next = { ...loadOverrides(file) };
	if (tokens === null) delete next[tabId];
	else next[tabId] = Math.floor(tokens);
	try {
		fs.mkdirSync(path.dirname(file), { recursive: true });
		fs.writeFileSync(file, JSON.stringify(next, null, 2), { mode: 0o600 });
	} catch {
		// An unwritable data dir leaves the override for this session only.
	}
	return next;
}

/** What the tab shows and compacts at: the override, else the detected reading. */
export function effectiveWindow(
	detected: ContextWindow | null | undefined,
	override: number | null | undefined,
): ContextWindow | null {
	if (typeof override === "number" && override >= 1)
		return { window: override, source: "override" };
	return detected ?? null;
}
