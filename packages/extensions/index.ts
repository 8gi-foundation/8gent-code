/**
 * 8gent Code - Extension System
 *
 * Public API for the extension loader. Provides a singleton manager
 * that loads extensions from ~/.8gent/extensions/ on first call.
 */

export type { ExtensionManifest, LoadedExtension, ExtensionToolDef, ExtensionManager } from "./types";
export { loadAllExtensions, collectExtensionTools } from "./loader";

import { loadAllExtensions, collectExtensionTools } from "./loader";
import type { ExtensionManager, LoadedExtension } from "./types";

let _manager: ExtensionManager | null = null;

/** Get or create the singleton extension manager */
export function getExtensionManager(): ExtensionManager {
  if (_manager) return _manager;

  const manager: ExtensionManager = {
    extensions: [],
    async loadAll() {
      manager.extensions = await loadAllExtensions();
      return manager.extensions;
    },
    getTools() {
      return collectExtensionTools(manager.extensions);
    },
  };

  _manager = manager;
  return manager;
}
