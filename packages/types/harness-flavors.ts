/**
 * Harness Flavor Capability Declarations
 *
 * Each external CLI we know how to /spawn declares the capabilities it
 * needs to function. The host loads these at spawn time, applies any
 * narrowing policy, and constructs the resulting `HarnessHostContract`.
 *
 * Adding a new flavor: append to FLAVOR_DECLARATIONS and (optionally) add
 * an entry to packages/terminal-tab/command-resolver presets so it can be
 * spawned via `/term <flavor>`.
 *
 * Issue: #2086
 */

import type {
	HarnessCapability,
	HarnessFlavorDeclaration,
} from "./harness-host-contract.js";

// ---------------------------------------------------------------------------
// Reusable building blocks
// ---------------------------------------------------------------------------

const FS_REPO_RW: HarnessCapability = {
	category: "filesystem",
	actions: ["read", "write", "list", "stat"],
	targets: ["./*", "./**"],
};

const FS_TMP_RW: HarnessCapability = {
	category: "filesystem",
	actions: ["read", "write", "delete", "list", "stat"],
	targets: ["/tmp/*", "/var/folders/*"],
};

const NET_LLM_PROVIDERS: HarnessCapability = {
	category: "network",
	actions: ["fetch", "resolve"],
	targets: [
		"api.openai.com",
		"api.anthropic.com",
		"api.openrouter.ai",
		"openrouter.ai",
		"api.groq.com",
		"api.mistral.ai",
		"localhost",
		"127.0.0.1",
	],
};

const NET_PUBLIC_FETCH: HarnessCapability = {
	category: "network",
	actions: ["fetch", "resolve"],
	targets: ["*"],
};

const PROC_DEV: HarnessCapability = {
	category: "process",
	actions: ["spawn", "signal"],
	targets: ["git", "node", "bun", "npm", "pnpm", "ls", "cat", "grep", "find"],
};

const MEM_FULL: HarnessCapability = {
	category: "memory",
	actions: ["read", "write", "search"],
	targets: ["episodic", "semantic", "procedural"],
};

const TOOLS_CORE_RW: HarnessCapability = {
	category: "tools",
	actions: ["execute", "list"],
	targets: [
		"read_file",
		"write_file",
		"edit_file",
		"list_dir",
		"shell",
		"glob",
		"grep",
	],
};

// ---------------------------------------------------------------------------
// Flavor declarations
// ---------------------------------------------------------------------------

export const CLAUDE_FLAVOR: HarnessFlavorDeclaration = {
	flavor: "claude",
	description:
		"Anthropic Claude Code CLI. Reads/writes the project repo, fetches the Anthropic API, runs dev tools.",
	required: [FS_REPO_RW, FS_TMP_RW, NET_LLM_PROVIDERS, PROC_DEV, MEM_FULL, TOOLS_CORE_RW],
};

export const OPENCLAW_FLAVOR: HarnessFlavorDeclaration = {
	flavor: "openclaw",
	description:
		"OpenClaw CLI. Same surface as Claude Code; broader fetch allowlist for tool installation.",
	required: [
		FS_REPO_RW,
		FS_TMP_RW,
		NET_PUBLIC_FETCH,
		PROC_DEV,
		MEM_FULL,
		TOOLS_CORE_RW,
	],
};

export const HERMES_FLAVOR: HarnessFlavorDeclaration = {
	flavor: "hermes",
	description:
		"Hermes harness. Read-mostly research and triage; cannot delete files or kill processes.",
	required: [
		{
			category: "filesystem",
			actions: ["read", "list", "stat"],
			targets: ["./*", "./**"],
		},
		{
			category: "network",
			actions: ["fetch", "resolve"],
			targets: ["*"],
		},
		{
			category: "process",
			actions: ["spawn"],
			targets: ["git", "grep", "rg", "find"],
		},
		{
			category: "memory",
			actions: ["read", "search"],
			targets: ["episodic", "semantic"],
		},
		{
			category: "tools",
			actions: ["execute", "list"],
			targets: ["read_file", "list_dir", "glob", "grep"],
		},
	],
};

/** All known harness flavor declarations, keyed by flavor id. */
export const FLAVOR_DECLARATIONS: Record<string, HarnessFlavorDeclaration> = {
	claude: CLAUDE_FLAVOR,
	openclaw: OPENCLAW_FLAVOR,
	hermes: HERMES_FLAVOR,
};

/** Look up a flavor declaration. Returns undefined if unknown. */
export function getFlavorDeclaration(flavor: string): HarnessFlavorDeclaration | undefined {
	return FLAVOR_DECLARATIONS[flavor];
}
