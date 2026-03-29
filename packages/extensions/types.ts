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
}

export interface ExtensionManager {
  extensions: LoadedExtension[];
  loadAll(): Promise<LoadedExtension[]>;
  getTools(): Record<string, Function>;
}
