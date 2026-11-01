/**
 * 8gent AI - Read-Only Demo Tools for Text-Tool Calling
 *
 * A minimal, READ-ONLY tool set used to demonstrate the text-tool agent loop
 * driving a local model agentically. Three tools: read_file, list_files, grep.
 * No write, no exec, no network. Each tool returns a plain string suitable for
 * feeding back to the model.
 *
 * These are intentionally simple (substring/line search, plain dir listing) and
 * safe to expose: nothing here can mutate the filesystem or run a process.
 */

import { readdirSync, readFileSync, statSync } from "node:fs";
import type { TextTool } from "./text-tool-loop";

const MAX_FILE_BYTES = 64 * 1024; // cap fed-back content to keep prompts bounded
const MAX_GREP_MATCHES = 50;

function str(args: Record<string, unknown>, key: string): string {
	const v = args[key];
	return typeof v === "string" ? v : "";
}

const readFileTool: TextTool = {
	spec: {
		name: "read_file",
		description:
			"Read the full text contents of a file at the given path. Returns the file text.",
		parameters: {
			type: "object",
			properties: {
				path: { type: "string", description: "Absolute or relative file path" },
			},
			required: ["path"],
		},
	},
	run: async (args) => {
		const path = str(args, "path");
		if (!path) return "Error: read_file requires a non-empty 'path'.";
		const info = statSync(path);
		if (info.isDirectory()) {
			return `Error: "${path}" is a directory, not a file. Use list_files.`;
		}
		const text = readFileSync(path, "utf-8");
		if (text.length > MAX_FILE_BYTES) {
			return `${text.slice(0, MAX_FILE_BYTES)}\n[...truncated, ${text.length} bytes total]`;
		}
		return text;
	},
};

const listFilesTool: TextTool = {
	spec: {
		name: "list_files",
		description:
			"List the entries (files and directories) in a directory. Directories are suffixed with a slash.",
		parameters: {
			type: "object",
			properties: {
				path: {
					type: "string",
					description: "Directory path to list (defaults to current directory)",
				},
			},
			required: [],
		},
	},
	run: async (args) => {
		const path = str(args, "path") || ".";
		const entries = readdirSync(path);
		if (entries.length === 0) return `(empty directory: ${path})`;
		const lines = entries.sort().map((name) => {
			try {
				const full = path.endsWith("/") ? `${path}${name}` : `${path}/${name}`;
				return statSync(full).isDirectory() ? `${name}/` : name;
			} catch {
				return name;
			}
		});
		return lines.join("\n");
	},
};

const grepTool: TextTool = {
	spec: {
		name: "grep",
		description:
			"Search for a literal substring within a single file and return matching lines with line numbers.",
		parameters: {
			type: "object",
			properties: {
				pattern: { type: "string", description: "Literal substring to search for" },
				path: { type: "string", description: "File path to search within" },
			},
			required: ["pattern", "path"],
		},
	},
	run: async (args) => {
		const pattern = str(args, "pattern");
		const path = str(args, "path");
		if (!pattern) return "Error: grep requires a non-empty 'pattern'.";
		if (!path) return "Error: grep requires a non-empty 'path'.";
		const info = statSync(path);
		if (info.isDirectory()) {
			return `Error: grep only searches a single file; "${path}" is a directory.`;
		}
		const text = readFileSync(path, "utf-8");
		const matches: string[] = [];
		const lines = text.split("\n");
		for (let i = 0; i < lines.length && matches.length < MAX_GREP_MATCHES; i++) {
			if (lines[i].includes(pattern)) {
				matches.push(`${i + 1}:${lines[i]}`);
			}
		}
		if (matches.length === 0) return `No matches for "${pattern}" in ${path}.`;
		return matches.join("\n");
	},
};

/**
 * The read-only demo tool set: read_file, list_files, grep. Returned as a fresh
 * array each call so callers can mutate it freely.
 */
export function getDemoTools(): TextTool[] {
	return [readFileTool, listFilesTool, grepTool];
}
