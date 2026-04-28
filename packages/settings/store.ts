/**
 * 8gent Code - Settings Store
 *
 * Synchronous load/save for ~/.8gent/settings.json.
 *
 * - loadSettings(): deep-merges the user file with DEFAULT_SETTINGS so adding
 *   new fields stays backward compatible. Tolerates missing/corrupt files.
 * - saveSettings(): pretty-prints JSON, creates ~/.8gent/ on demand, never
 *   throws on filesystem failure (best-effort persistence).
 * - getSetting / setSetting: typed key-level helpers that round-trip through
 *   the file so concurrent processes see each other's changes.
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { DEFAULT_SETTINGS } from "./defaults.js";
import type { Settings } from "./schema.js";

const SETTINGS_DIR = path.join(os.homedir(), ".8gent");
const SETTINGS_FILE = path.join(SETTINGS_DIR, "settings.json");

function ensureDir(): void {
	try {
		if (!fs.existsSync(SETTINGS_DIR)) {
			fs.mkdirSync(SETTINGS_DIR, { recursive: true });
		}
	} catch {
		// Best-effort. saveSettings will swallow any subsequent write error.
	}
}

/**
 * Recursively merge `user` over `defaults`, preserving the shape of `defaults`.
 * Arrays and primitives from `user` replace defaults wholesale. Plain objects
 * are merged key-by-key.
 */
function deepMerge<T>(defaults: T, user: unknown): T {
	if (user === null || user === undefined) return defaults;
	if (typeof defaults !== "object" || defaults === null) {
		// Primitive or array — accept user value if its type matches the default.
		// Otherwise fall back to default to keep the shape valid.
		if (typeof user === typeof defaults) return user as T;
		return defaults;
	}
	if (Array.isArray(defaults)) {
		return Array.isArray(user) ? (user as T) : defaults;
	}
	const out: Record<string, unknown> = { ...(defaults as Record<string, unknown>) };
	if (typeof user === "object" && user !== null && !Array.isArray(user)) {
		const u = user as Record<string, unknown>;
		for (const key of Object.keys(out)) {
			if (key in u) {
				out[key] = deepMerge((defaults as Record<string, unknown>)[key], u[key]);
			}
		}
	}
	return out as T;
}

/**
 * Load settings from ~/.8gent/settings.json, deep-merged onto DEFAULT_SETTINGS.
 * Returns DEFAULT_SETTINGS if the file is missing, unreadable, or corrupt.
 */
export function loadSettings(): Settings {
	try {
		if (!fs.existsSync(SETTINGS_FILE)) {
			return DEFAULT_SETTINGS;
		}
		const raw = fs.readFileSync(SETTINGS_FILE, "utf-8");
		const parsed = JSON.parse(raw) as unknown;
		const merged = deepMerge(DEFAULT_SETTINGS, parsed);
		// Force version to current — older files get implicitly upgraded.
		return { ...merged, version: DEFAULT_SETTINGS.version };
	} catch {
		return DEFAULT_SETTINGS;
	}
}

/**
 * Persist settings to ~/.8gent/settings.json. Creates the directory if needed.
 * Never throws on filesystem errors.
 */
export function saveSettings(s: Settings): void {
	try {
		ensureDir();
		fs.writeFileSync(SETTINGS_FILE, `${JSON.stringify(s, null, 2)}\n`, "utf-8");
	} catch {
		// Best-effort persistence
	}
}

/** Read a single top-level key. */
export function getSetting<K extends keyof Settings>(key: K): Settings[K] {
	return loadSettings()[key];
}

/** Update a single top-level key and persist. */
export function setSetting<K extends keyof Settings>(key: K, value: Settings[K]): void {
	const current = loadSettings();
	saveSettings({ ...current, [key]: value });
}

/** Absolute path to the settings file (for debugging / display). */
export function getSettingsFilePath(): string {
	return SETTINGS_FILE;
}
