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
import {
	type IgnoredSetting,
	filterProjectSettings,
	getPath,
	readProjectSettingsFile,
	setPath,
} from "./project.js";
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
	// A null default means "unset, any value". Consumers validate it (see retry.ts).
	if (defaults === null) return user as T;
	if (typeof defaults !== "object") {
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
 * Load ONLY the global file (~/.8gent/settings.json), deep-merged onto
 * DEFAULT_SETTINGS. Returns DEFAULT_SETTINGS if the file is missing,
 * unreadable, or corrupt. Writers start from this, never from loadSettings().
 */
export function loadGlobalSettings(): Settings {
	try {
		const file = settingsFile();
		if (!fs.existsSync(file)) {
			return DEFAULT_SETTINGS;
		}
		const raw = fs.readFileSync(file, "utf-8");
		const parsed = JSON.parse(raw) as unknown;
		const merged = deepMerge(DEFAULT_SETTINGS, parsed);
		// Force version to current - older files get implicitly upgraded.
		return { ...merged, version: DEFAULT_SETTINGS.version };
	} catch {
		return DEFAULT_SETTINGS;
	}
}

/** What the project file changed in the last load: the values to take back out on save. */
interface Overlay {
	path: string;
	projectValue: unknown;
	globalValue: unknown;
}
let lastOverlay: Overlay[] = [];

export interface SettingsReport {
	settings: Settings;
	/** The project file that was read, when there is one. */
	projectFile?: string;
	/** Keys the project file set that were applied (dotted paths). */
	applied: string[];
	/** Keys the project file set that are not allowed here, with the reason. */
	ignored: IgnoredSetting[];
}

/**
 * Global settings with <cwd>/.8gent/settings.json deep-merged over them, but
 * only through the allowlist in project.ts (a project file is repo content).
 * Also says what was applied and what was ignored.
 */
export function loadSettingsReport(cwd: string = process.cwd()): SettingsReport {
	const global = loadGlobalSettings();
	const read = readProjectSettingsFile(cwd, settingsFile());
	lastOverlay = [];
	if (!read) return { settings: global, applied: [], ignored: [] };
	if ("error" in read) {
		return {
			settings: global,
			projectFile: read.file,
			applied: [],
			ignored: [{ path: "(file)", reason: read.error }],
		};
	}
	const { accepted, ignored } = filterProjectSettings(read.parsed, global);
	const merged = structuredClone(global) as unknown as Record<string, unknown>;
	for (const [dotted, value] of Object.entries(accepted)) {
		lastOverlay.push({ path: dotted, projectValue: value, globalValue: getPath(global, dotted) });
		setPath(merged, dotted, value);
	}
	return {
		settings: merged as unknown as Settings,
		projectFile: read.file,
		applied: Object.keys(accepted),
		ignored,
	};
}

const reported = new Set<string>();

/** One stderr line per ignored key per project file per process. */
function reportIgnored(file: string, ignored: IgnoredSetting[]): void {
	for (const ig of ignored) {
		const key = `${file}\u0000${ig.path}`;
		if (reported.has(key)) continue;
		reported.add(key);
		try {
			process.stderr.write(`[settings] ignored ${ig.path} in ${file}: ${ig.reason}\n`);
		} catch {}
	}
}

/**
 * The settings in force: global, with the allowlisted keys of
 * <cwd>/.8gent/settings.json over them. Anything else in the project file is
 * ignored and reported once on stderr. Never throws.
 */
export function loadSettings(cwd: string = process.cwd()): Settings {
	try {
		const r = loadSettingsReport(cwd);
		if (r.projectFile && r.ignored.length > 0) reportIgnored(r.projectFile, r.ignored);
		return r.settings;
	} catch {
		return DEFAULT_SETTINGS;
	}
}

/**
 * Persist settings to ~/.8gent/settings.json. Creates the directory if needed.
 * Never throws on filesystem errors. Writes always go to the GLOBAL file. A
 * value the project file supplied and the caller did not change is written
 * back as the global value, so opening /settings in a repo never copies that
 * repo's overrides into the user's own file.
 */
export function saveSettings(s: Settings): void {
	try {
		ensureDir();
		let out = s;
		if (lastOverlay.length > 0) {
			const clone = structuredClone(s) as unknown as Record<string, unknown>;
			for (const o of lastOverlay) {
				if (JSON.stringify(getPath(s, o.path)) === JSON.stringify(o.projectValue)) {
					setPath(clone, o.path, o.globalValue);
				}
			}
			out = clone as unknown as Settings;
		}
		fs.writeFileSync(settingsFile(), `${JSON.stringify(out, null, 2)}\n`, "utf-8");
	} catch {
		// Best-effort persistence
	}
}

/** Read a single top-level key (project overrides applied). */
export function getSetting<K extends keyof Settings>(key: K): Settings[K] {
	return loadSettings()[key];
}

/** Update a single top-level key and persist it to the global file. */
export function setSetting<K extends keyof Settings>(key: K, value: Settings[K]): void {
	const current = loadGlobalSettings();
	saveSettings({ ...current, [key]: value });
}

/** Absolute path to the settings file (for debugging / display). */
export function getSettingsFilePath(): string {
	return settingsFile();
}
