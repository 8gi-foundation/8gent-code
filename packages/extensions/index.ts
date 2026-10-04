/**
 * 8gent Code - Extension System
 *
 * Public API for the extension loader. Provides a singleton manager
 * that loads extensions from ~/.8gent/extensions/ on first call.
 */

export type {
	ExtensionManifest,
	LoadedExtension,
	ExtensionToolDef,
	ExtensionManager,
} from "./types";
export { loadAllExtensions, loadExtension, collectExtensionTools } from "./loader";
export { createScope, scopeEnabled, type ExtensionScope } from "./scope";

import { collectExtensionTools, loadAllExtensions, loadExtension } from "./loader";
import { scopeEnabled } from "./scope";
import type { ExtensionManager } from "./types";

let _manager: ExtensionManager | null = null;

const OFF = { errors: ["[ext] unload/reload need EIGHT_EXT_SCOPE=1"] };

/** Build a manager. `dir` and `activateTimeoutMs` are overridable for tests. */
export function createExtensionManager(
	opts: { dir?: string; activateTimeoutMs?: number } = {},
): ExtensionManager {
	const timeout = { activateTimeoutMs: opts.activateTimeoutMs };
	const manager: ExtensionManager = {
		extensions: [],
		async loadAll() {
			manager.extensions = await loadAllExtensions(opts.dir, timeout);
			return manager.extensions;
		},
		getTools() {
			return collectExtensionTools(manager.extensions);
		},
		async unload(name) {
			if (!scopeEnabled()) return OFF;
			const ext = manager.extensions.find((e) => e.manifest.name === name);
			if (!ext) return { errors: [`[ext] ${name}: not loaded`] };
			manager.extensions = manager.extensions.filter((e) => e !== ext);
			const res = (await ext.scope?.dispose()) ?? { errors: [] };
			for (const e of res.errors) console.warn(e);
			return res;
		},
		async reload(name) {
			if (!scopeEnabled()) return OFF;
			const dir = manager.extensions.find((e) => e.manifest.name === name)?.dir;
			if (!dir) return { errors: [`[ext] ${name}: not loaded`] };
			const { errors } = await manager.unload(name);
			const ext = await loadExtension(dir, { ...timeout, fresh: true });
			manager.extensions.push(ext);
			return { errors: ext.error ? [...errors, ext.error] : errors };
		},
	};
	return manager;
}

/** Get or create the singleton extension manager */
export function getExtensionManager(): ExtensionManager {
	_manager ??= createExtensionManager();
	return _manager;
}

export { craftExtension, type CraftOptions, type CraftResult } from "./crafter";
