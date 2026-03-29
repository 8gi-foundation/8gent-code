/**
 * 8gent Code - Extension Loader
 *
 * Scans ~/.8gent/extensions/ for directories containing 8gent-extension.json,
 * validates manifests, dynamically imports entry modules, and collects tools.
 */

import * as fs from "fs";
import * as path from "path";
import type { ExtensionManifest, LoadedExtension, ExtensionToolDef } from "./types";

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
async function loadExtension(dir: string): Promise<LoadedExtension> {
  const manifestPath = path.join(dir, MANIFEST_FILE);

  // Parse manifest
  let manifest: ExtensionManifest;
  try {
    const raw = JSON.parse(fs.readFileSync(manifestPath, "utf-8"));
    const validated = validateManifest(raw);
    if (!validated) {
      return { manifest: { name: path.basename(dir), version: "0.0.0", description: "", entry: "" }, dir, module: {}, status: "error", error: "Invalid manifest" };
    }
    manifest = validated;
  } catch (err) {
    return { manifest: { name: path.basename(dir), version: "0.0.0", description: "", entry: "" }, dir, module: {}, status: "error", error: `Manifest read failed: ${err}` };
  }

  // Dynamic import of entry module
  const entryPath = path.resolve(dir, manifest.entry);
  if (!fs.existsSync(entryPath)) {
    return { manifest, dir, module: {}, status: "error", error: `Entry not found: ${entryPath}` };
  }

  try {
    const mod = await import(entryPath);
    return { manifest, dir, module: mod, status: "loaded" };
  } catch (err) {
    return { manifest, dir, module: {}, status: "error", error: `Import failed: ${err}` };
  }
}

/** Scan extensions directory and load all valid extensions */
export async function loadAllExtensions(): Promise<LoadedExtension[]> {
  if (!fs.existsSync(EXTENSIONS_DIR)) return [];

  const entries = fs.readdirSync(EXTENSIONS_DIR, { withFileTypes: true });
  const dirs = entries
    .filter((e) => e.isDirectory())
    .map((e) => path.join(EXTENSIONS_DIR, e.name))
    .filter((d) => fs.existsSync(path.join(d, MANIFEST_FILE)));

  const results = await Promise.allSettled(dirs.map(loadExtension));

  const loaded: LoadedExtension[] = [];
  for (const result of results) {
    if (result.status === "fulfilled") {
      loaded.push(result.value);
      const ext = result.value;
      if (ext.status === "loaded") {
        console.log(`[ext] Loaded: ${ext.manifest.name}@${ext.manifest.version}`);
      } else {
        console.log(`[ext] Failed: ${ext.manifest.name} - ${ext.error}`);
      }
    }
  }
  return loaded;
}

/** Collect tool functions from loaded extensions */
export function collectExtensionTools(
  extensions: LoadedExtension[],
): Record<string, Function> {
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
  }
  return tools;
}
