/**
 * 8gent Code - Extension Loader
 *
 * Scans ~/.8gent/extensions/ for directories containing 8gent-extension.json,
 * validates manifests, dynamically imports entry modules, and collects tools.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { PROCESS_MANIFEST, isEnabled, readProcessManifest, startProcessExtension } from "./process";
import { createScope, scopeEnabled } from "./scope";
import type { ExtensionManifest, ExtensionToolDef, LoadedExtension } from "./types";

export interface LoadOptions {
	/** Bypass the module cache so a reload picks up edits. */
	fresh?: boolean;
	/** Max time activate() may take before it is rolled back. Default 5000 ms. */
	activateTimeoutMs?: number;
}

const EXTENSIONS_DIR = path.join(
	process.env.HOME || process.env.USERPROFILE || "~",
	".8gent",
	"extensions",
);

const MANIFEST_FILE = "8gent-extension.json";

/** Validate a parsed manifest has required fields */
function validateManifest(raw: unknown): ExtensionManifest | null {
	if (!raw || typeof raw !== "object") return null;
	const m = raw as Record<string, unknown>;
	if (typeof m.name !== "string" || !m.name) return null;
	if (typeof m.version !== "string") return null;
	if (typeof m.description !== "string") return null;
	if (typeof m.entry !== "string" || !m.entry) return null;
	return m as unknown as ExtensionManifest;
}

/** Load a single extension from a directory */
export async function loadExtension(dir: string, opts: LoadOptions = {}): Promise<LoadedExtension> {
	// Preferred shape: a separate process named by manifest.json, off until enabled.
	const pm = fs.existsSync(path.join(dir, PROCESS_MANIFEST)) ? readProcessManifest(dir) : null;
	if (pm) {
		const base = { dir, module: {}, manifest: { ...pm, entry: pm.command } };
		if (!isEnabled(dir, PROCESS_MANIFEST)) return { ...base, status: "disabled" };
		try {
			const ext = await startProcessExtension(dir);
			return { ...base, module: { tools: ext.tools } as never, status: "loaded", close: ext.close };
		} catch (err) {
			return { ...base, status: "error", error: `Start failed: ${err}` };
		}
	}
	const manifestPath = path.join(dir, MANIFEST_FILE);

	// Parse manifest
	let manifest: ExtensionManifest;
	try {
		const raw = JSON.parse(fs.readFileSync(manifestPath, "utf-8"));
		const validated = validateManifest(raw);
		if (!validated) {
			return {
				manifest: {
					name: path.basename(dir),
					version: "0.0.0",
					description: "",
					entry: "",
				},
				dir,
				module: {},
				status: "error",
				error: "Invalid manifest",
			};
		}
		manifest = validated;
	} catch (err) {
		return {
			manifest: {
				name: path.basename(dir),
				version: "0.0.0",
				description: "",
				entry: "",
			},
			dir,
			module: {},
			status: "error",
			error: `Manifest read failed: ${err}`,
		};
	}

	// Dynamic import of entry module
	const entryPath = path.resolve(dir, manifest.entry);
	if (!fs.existsSync(entryPath)) {
		return {
			manifest,
			dir,
			module: {},
			status: "error",
			error: `Entry not found: ${entryPath}`,
		};
	}

	// In-process loading (agent.ts still calls this on startup) is off until a person enables it.
	if (!isEnabled(dir, MANIFEST_FILE)) return { manifest, dir, module: {}, status: "disabled" };

	try {
		const mod = await import(opts.fresh ? `${entryPath}?t=${Date.now()}` : entryPath);
		if (!scopeEnabled() || typeof mod.activate !== "function") {
			return { manifest, dir, module: mod, status: "loaded" };
		}
		const scope = createScope(manifest.name);
		const ms = opts.activateTimeoutMs ?? 5000;
		let timer: ReturnType<typeof setTimeout> | undefined;
		try {
			await Promise.race([
				Promise.resolve().then(() => mod.activate(scope)),
				new Promise((_, reject) => {
					timer = setTimeout(() => reject(new Error(`activate timed out after ${ms} ms`)), ms);
				}),
			]);
		} catch (err) {
			// Undo whatever activate managed to register before it threw.
			const { errors } = await scope.dispose();
			return {
				manifest,
				dir,
				module: {},
				status: "error",
				error: [`Activate failed: ${err}`, ...errors].join("; "),
			};
		} finally {
			clearTimeout(timer);
		}
		return { manifest, dir, module: mod, status: "loaded", scope };
	} catch (err) {
		return {
			manifest,
			dir,
			module: {},
			status: "error",
			error: `Import failed: ${err}`,
		};
	}
}

/** Scan extensions directory and load all valid extensions */
export async function loadAllExtensions(
	root: string = EXTENSIONS_DIR,
	opts: LoadOptions = {},
): Promise<LoadedExtension[]> {
	if (!fs.existsSync(root)) return [];

	const entries = fs.readdirSync(root, { withFileTypes: true });
	const dirs = entries
		.filter((e) => e.isDirectory())
		.map((e) => path.join(root, e.name))
		.filter(
			(d) =>
				fs.existsSync(path.join(d, MANIFEST_FILE)) || fs.existsSync(path.join(d, PROCESS_MANIFEST)),
		);

	const results = await Promise.allSettled(dirs.map((d) => loadExtension(d, opts)));

	const loaded: LoadedExtension[] = [];
	for (const result of results) {
		if (result.status === "fulfilled") {
			loaded.push(result.value);
			const ext = result.value;
			if (ext.status === "loaded") {
				console.log(`[ext] Loaded: ${ext.manifest.name}@${ext.manifest.version}`);
			} else if (ext.status === "error") {
				console.log(`[ext] Failed: ${ext.manifest.name} - ${ext.error}`);
			}
		}
	}
	return loaded;
}

/** Collect tool functions from loaded extensions */
export function collectExtensionTools(extensions: LoadedExtension[]): Record<string, Function> {
	const tools: Record<string, Function> = {};
	for (const ext of extensions) {
		if (ext.status !== "loaded") continue;

		// Check for exported tools object
		if (ext.module.tools && typeof ext.module.tools === "object") {
			for (const [name, fn] of Object.entries(ext.module.tools)) {
				if (typeof fn === "function") {
					tools[`${ext.manifest.name}:${name}`] = fn;
				}
			}
		}

		// Check for manifest-declared tool names mapped to exported functions
		if (ext.manifest.tools) {
			for (const def of ext.manifest.tools) {
				const fn = ext.module[def.name];
				if (typeof fn === "function") {
					tools[`${ext.manifest.name}:${def.name}`] = fn;
				}
			}
		}

		// Tools registered through the revertible scope (EIGHT_EXT_SCOPE=1)
		for (const [name, fn] of Object.entries(ext.scope?.tools ?? {})) {
			tools[`${ext.manifest.name}:${name}`] = fn;
		}
	}
	return tools;
}
