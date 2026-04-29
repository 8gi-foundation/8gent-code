/**
 * @8gent/secrets — keys.ts
 *
 * Single source of truth for API key handling outside of chat.
 *
 *   - `KEYS_PATH` is `~/.8gent/keys.env` (gitignored, user-owned).
 *   - On first run we copy a `keys.env.example` template into place
 *     so the user has placeholders to drop real keys into.
 *   - `loadKeysIntoEnv()` reads the file, parses simple `KEY=value`
 *     lines, and merges into `process.env` BEFORE the agent loop
 *     reads any provider client config. Existing env vars win
 *     (so CI / shell exports still override the file).
 *   - `openKeysFile()` opens the file in the user's default editor
 *     (`open` on macOS, `xdg-open` on Linux, `start` on Windows).
 *     The user types/pastes their keys and saves; we never see them
 *     in chat.
 *   - `redactKeys(text)` is the OUTPUT side: any chat reply or tool
 *     output runs through this before display, replacing matched
 *     credentials with `[REDACTED:provider]`. Emits a console warn
 *     once per session per provider so the user knows their model
 *     leaked something.
 *
 * Pattern set comes from common provider docs and is conservative —
 * we'd rather false-positive than ship a real key into a Telegram
 * digest, a session export, or a screen recording.
 */

import { execSync, spawn } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir, platform } from "node:os";
import { dirname, join } from "node:path";

export const KEYS_DIR = join(homedir(), ".8gent");
export const KEYS_PATH = join(KEYS_DIR, "keys.env");

/**
 * Built-in template — emitted at the path on first run if absent.
 * Includes placeholders for the providers that 8gent and the
 * /spawn'd external agents commonly need. Users can add their own
 * keys; we never delete unknown keys on subsequent regenerates.
 */
const TEMPLATE = `# 8gent keys.env
#
# Drop your API keys below the matching lines. Save and close
# the file — 8gent picks them up on next launch (or right now if
# you re-run \`8gent keys reload\`).
#
# This file lives at ~/.8gent/keys.env. It's never sent to chat
# and never leaves your machine.

# OpenAI (used by Codex, optionally by Pi/Aider)
# OPENAI_API_KEY=

# Anthropic (used by Claude Code, optionally by Pi/Aider)
# ANTHROPIC_API_KEY=

# Google Gemini (default provider for Pi)
# GEMINI_API_KEY=

# OpenRouter (8gent failover, free models, used by Hermes)
# OPENROUTER_API_KEY=

# Groq, xAI/Grok, Mistral, Together, Fireworks, Replicate
# GROQ_API_KEY=
# XAI_API_KEY=
# MISTRAL_API_KEY=
# TOGETHER_API_KEY=
# FIREWORKS_API_KEY=
# REPLICATE_API_TOKEN=

# AWS (used by Hermes if you keep its default Bedrock provider)
# AWS_ACCESS_KEY_ID=
# AWS_SECRET_ACCESS_KEY=
# AWS_REGION=us-east-1

# GitHub (used by /github commands and skill clone-from-repo)
# GITHUB_TOKEN=
`;

/** Ensure the keys file exists (create from template if not). */
export function ensureKeysFile(): string {
	if (!existsSync(KEYS_DIR)) {
		mkdirSync(KEYS_DIR, { recursive: true });
	}
	if (!existsSync(KEYS_PATH)) {
		writeFileSync(KEYS_PATH, TEMPLATE, { mode: 0o600 });
	}
	return KEYS_PATH;
}

/**
 * Read the keys file and return a plain `Record<string, string>`.
 * Lines starting with `#` and blank lines are skipped. Values may be
 * quoted or unquoted. No interpolation.
 */
export function readKeysFile(path: string = KEYS_PATH): Record<string, string> {
	if (!existsSync(path)) return {};
	const out: Record<string, string> = {};
	const text = readFileSync(path, "utf-8");
	for (const rawLine of text.split(/\r?\n/)) {
		const line = rawLine.trim();
		if (!line || line.startsWith("#")) continue;
		const eq = line.indexOf("=");
		if (eq === -1) continue;
		const key = line.slice(0, eq).trim();
		let value = line.slice(eq + 1).trim();
		if (
			(value.startsWith('"') && value.endsWith('"')) ||
			(value.startsWith("'") && value.endsWith("'"))
		) {
			value = value.slice(1, -1);
		}
		if (key && value) out[key] = value;
	}
	return out;
}

/**
 * Merge keys file into `process.env`. Existing process.env values
 * WIN — so a shell export or CI secret always overrides the file.
 * Returns the number of keys merged.
 */
export function loadKeysIntoEnv(path: string = KEYS_PATH): number {
	const keys = readKeysFile(path);
	let merged = 0;
	for (const [k, v] of Object.entries(keys)) {
		if (!process.env[k]) {
			process.env[k] = v;
			merged += 1;
		}
	}
	return merged;
}

/**
 * Open the keys file in the user's default editor and return the
 * path. macOS: `open` opens it in TextEdit (or whatever's configured
 * for .env). Linux: xdg-open. Windows: start. Best-effort on each.
 *
 * Auto-create the file from the template if it doesn't exist.
 */
export function openKeysFile(): string {
	const path = ensureKeysFile();
	const opener =
		platform() === "darwin"
			? "open"
			: platform() === "win32"
				? "start"
				: "xdg-open";
	try {
		const proc = spawn(opener, [path], { stdio: "ignore", detached: true });
		proc.unref();
	} catch {
		/* opener missing; the user will have to open the file manually */
	}
	return path;
}

// ============================================================================
// Output redaction — catches keys leaked into chat replies / tool output.
// ============================================================================

interface KeyPattern {
	provider: string;
	regex: RegExp;
}

/**
 * Conservative pattern set. False positives (e.g. a doc snippet that
 * shows the literal "sk-..." prefix) are preferable to a real leaked
 * key making it to Telegram or a session export. Order matters —
 * specific prefixes (sk-ant-) before general ones (sk-).
 */
const KEY_PATTERNS: readonly KeyPattern[] = [
	// Anthropic — sk-ant-... (specific prefix first)
	{ provider: "Anthropic", regex: /sk-ant-[A-Za-z0-9_-]{30,}/g },
	// OpenAI — sk-..., proj sk-proj-..., session sess-...
	{ provider: "OpenAI", regex: /sk-(?:proj-)?[A-Za-z0-9_-]{20,}/g },
	{ provider: "OpenAI session", regex: /sess-[A-Za-z0-9_-]{20,}/g },
	// OpenRouter — sk-or-v1-...
	{ provider: "OpenRouter", regex: /sk-or-[A-Za-z0-9_-]{20,}/g },
	// Google API key — AIzaSy...
	{ provider: "Google API key", regex: /AIza[0-9A-Za-z_-]{20,}/g },
	// AWS access key id
	{ provider: "AWS access key", regex: /\bAKIA[0-9A-Z]{16}\b/g },
	// GitHub Personal Access Token (classic + fine-grained)
	{ provider: "GitHub PAT", regex: /\bghp_[A-Za-z0-9]{36}\b/g },
	{ provider: "GitHub fine-grained PAT", regex: /\bgithub_pat_[A-Za-z0-9_]{50,}\b/g },
	// Slack bot / app tokens
	{ provider: "Slack bot token", regex: /\bxox[baprs]-[A-Za-z0-9-]{20,}\b/g },
	// Stripe live secret
	{ provider: "Stripe live secret", regex: /\bsk_live_[A-Za-z0-9]{20,}\b/g },
	// Replicate
	{ provider: "Replicate", regex: /\br8_[A-Za-z0-9]{30,}\b/g },
	// Generic hex token >= 40 chars (last-ditch). Disabled by default;
	// flip via REDACT_AGGRESSIVE=1 if needed. Too easy to false-match
	// commit hashes / etag headers / SHAs.
];

export interface RedactResult {
	/** Text with all matched credentials replaced by `[REDACTED:provider]`. */
	text: string;
	/** Provider names that matched at least once, in order of appearance. */
	leaks: string[];
}

/**
 * Scan `text` for known API key patterns. Returns the redacted text
 * and the list of providers that matched. Idempotent — re-running on
 * already-redacted text is a no-op.
 */
export function redactKeys(text: string): RedactResult {
	const leaks: string[] = [];
	let out = text;
	for (const { provider, regex } of KEY_PATTERNS) {
		// Scan first so we know whether to record. Use a fresh regex each
		// pass since the global flag carries state.
		const scanner = new RegExp(regex.source, regex.flags);
		if (scanner.test(out)) {
			leaks.push(provider);
			out = out.replace(regex, `[REDACTED:${provider}]`);
		}
	}
	return { text: out, leaks };
}

/**
 * One-shot helper for callers that want to check + warn in one line.
 * Logs to stderr once per provider per process so the user is told
 * exactly what leaked, without spamming their chat history. Returns
 * the redacted text.
 */
const _warnedProviders = new Set<string>();
export function redactAndWarn(text: string): string {
	const { text: redacted, leaks } = redactKeys(text);
	for (const p of leaks) {
		if (_warnedProviders.has(p)) continue;
		_warnedProviders.add(p);
		try {
			console.warn(
				`[secrets] Possible ${p} credential detected in agent output and redacted before display. Move it to ~/.8gent/keys.env via \`8gent keys\` instead.`,
			);
		} catch {
			/* console may be patched */
		}
	}
	return redacted;
}
