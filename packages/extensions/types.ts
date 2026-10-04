import type { ExtensionScope } from "./scope";

/**
 * 8gent Code - Extension System Types
 *
 * Type definitions for the extension loader. Each extension lives in
 * ~/.8gent/extensions/<name>/ with an 8gent-extension.json manifest.
 */

export interface ExtensionManifest {
	name: string;
	version: string;
	description: string;
	author?: string;
	entry: string;
	permissions?: string[];
	tools?: ExtensionToolDef[];
	hooks?: {
		onSessionStart?: string;
		onSessionEnd?: string;
		onToolCall?: string;
		onMessage?: string;
	};
}

export interface ExtensionToolDef {
	name: string;
	description: string;
	parameters: Record<string, { type: string; description?: string; required?: boolean }>;
}

export interface LoadedExtension {
	manifest: ExtensionManifest;
	dir: string;
	module: Record<string, Function>;
	status: "loaded" | "error";
	error?: string;
	/** Present only when EIGHT_EXT_SCOPE=1 and the module exports activate(scope). */
	scope?: ExtensionScope;
}

export interface ExtensionManager {
	extensions: LoadedExtension[];
	loadAll(): Promise<LoadedExtension[]>;
	getTools(): Record<string, Function>;
	/** Run every undo the extension registered, then drop it. Needs EIGHT_EXT_SCOPE=1. */
	unload(name: string): Promise<{ errors: string[] }>;
	/** Unload, then load the same directory fresh. Needs EIGHT_EXT_SCOPE=1. */
	reload(name: string): Promise<{ errors: string[] }>;
}
