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
import * as path from "node:path";
import { resolveHome } from "../core/home.js";
import { DEFAULT_SETTINGS } from "./defaults.js";
import type { Settings } from "./schema.js";

// Resolved on every call through resolveHome(), which honours EIGHT_HOME and
// $HOME. Bun fixes os.homedir() at process start, so it ignored the test
// preload's temp HOME and let tests touch the real settings file (#3391).
function settingsDir(): string {
	return path.join(resolveHome(), ".8gent");
}

function settingsFile(): string {
	return path.join(settingsDir(), "settings.json");
}

function ensureDir(): void {
	try {
		const dir = settingsDir();
		if (!fs.existsSync(dir)) {
			fs.mkdirSync(dir, { recursive: true });
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
		const file = settingsFile();
		if (!fs.existsSync(file)) {
			return DEFAULT_SETTINGS;
		}
		const raw = fs.readFileSync(file, "utf-8");
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
		fs.writeFileSync(settingsFile(), `${JSON.stringify(s, null, 2)}\n`, "utf-8");
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
	return settingsFile();
}
