/**
 * Installed-app registry.
 *
 * Persists app lifecycle state (enabled/disabled, version, install
 * path, manifest) as JSON on disk so it survives agent restarts.
 * Kept independent of the SQLite primitives store because the SQLite
 * binding (`better-sqlite3`) doesn't load under Bun, and this state
 * needs to be readable by the same Bun process that does the install.
 *
 * Default location: $EIGHTGENT_APPS_DIR/installed.json (or
 * ~/.8gent/apps/installed.json).
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

export interface InstalledAppRow {
	name: string;
	version: string;
	installPath: string;
	enabled: number;
	manifest: string;
	installedAt: string;
}

interface Store {
	apps: Record<string, InstalledAppRow>;
}

export function installedAppsStorePath(): string {
	const dir = process.env.EIGHTGENT_APPS_DIR || path.join(os.homedir(), ".8gent", "apps");
	return path.join(dir, "installed.json");
}

function readStore(): Store {
	const p = installedAppsStorePath();
	if (!fs.existsSync(p)) return { apps: {} };
	try {
		const parsed = JSON.parse(fs.readFileSync(p, "utf-8"));
		if (parsed && typeof parsed === "object" && parsed.apps) {
			return parsed as Store;
		}
		return { apps: {} };
	} catch {
		return { apps: {} };
	}
}

function writeStore(store: Store): void {
	const p = installedAppsStorePath();
	fs.mkdirSync(path.dirname(p), { recursive: true });
	const tmp = `${p}.${process.pid}.tmp`;
	fs.writeFileSync(tmp, JSON.stringify(store, null, 2));
	fs.renameSync(tmp, p);
}

export function registerInstalledApp(row: InstalledAppRow): void {
	const store = readStore();
	store.apps[row.name] = row;
	writeStore(store);
}

export function getInstalledApp(name: string): InstalledAppRow | null {
	const store = readStore();
	return store.apps[name] ?? null;
}

export function listInstalledApps(): InstalledAppRow[] {
	const store = readStore();
	return Object.values(store.apps).sort((a, b) => a.name.localeCompare(b.name));
}

export function setAppEnabled(name: string, enabled: number): void {
	const store = readStore();
	const row = store.apps[name];
	if (!row) return;
	row.enabled = enabled;
	writeStore(store);
}

export function unregisterInstalledApp(name: string): void {
	const store = readStore();
	if (!(name in store.apps)) return;
	delete store.apps[name];
	writeStore(store);
}
