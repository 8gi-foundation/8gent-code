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
import { randomBytes } from "node:crypto";
import {
	closeSync,
	copyFileSync,
	existsSync,
	fchmodSync,
	constants as fsConstants,
	fsyncSync,
	lstatSync,
	mkdirSync,
	openSync,
	readFileSync,
	renameSync,
	rmSync,
	writeFileSync,
	writeSync,
} from "node:fs";
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
	// Strip UTF-8 BOM. Notepad on Windows saves files with a BOM by default
	// and that byte would otherwise be glued to the first key name, so
	// `process.env["﻿OPENAI_API_KEY"]` is set instead of OPENAI_API_KEY
	// and every downstream provider lookup misses.
	const raw = readFileSync(path, "utf-8");
	const text = raw.charCodeAt(0) === 0xfeff ? raw.slice(1) : raw;
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

/** A pasted value shorter than this is not a real provider key. */
export const MIN_SET_KEY_CHARS = 20;

/**
 * Names `setKeyInFile` may write. Only credential-shaped names: the keys file is
 * merged into the environment and its endpoint overrides (MINIMAX_BASE_URL and
 * friends) are honoured, so a providers.json entry whose `apiKeyEnv` named a
 * URL, PATH, NODE_OPTIONS or an EIGHT_ switch must not turn a pasted value into
 * that variable (8SO, #4681).
 */
const SETTABLE_KEY_NAME = /^[A-Z][A-Z0-9_]*_(API_KEY|API_TOKEN|KEY|TOKEN)$/;

/**
 * A provider key is one token of printable ASCII. No whitespace or control
 * bytes (a pasted escape sequence or line break could start a second line),
 * and none of the characters a shell would expand if the file were ever
 * sourced: quotes, backtick, dollar, backslash.
 */
const SETTABLE_KEY_VALUE = /^[\x21-\x7e]+$/;
const SHELL_ACTIVE = /["'`$\\]/;

/** Read a file without following a symlink at its final component. "" when absent. */
function readNoFollow(path: string): string {
	let fd: number;
	try {
		fd = openSync(path, fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW ?? 0));
	} catch (e) {
		if ((e as NodeJS.ErrnoException).code === "ENOENT") return "";
		throw e;
	}
	try {
		return readFileSync(fd, "utf-8");
	} finally {
		closeSync(fd);
	}
}

/**
 * Set one `NAME=value` line in the keys file (replacing any earlier line for
 * NAME). Returns an error string and writes nothing when the name is not a
 * credential name, the value is too short or not a single printable token, or
 * the keys file is a symlink or not a regular file. Never echoes the value.
 *
 * The write is atomic and never at wider permissions: a sibling temp file is
 * created O_EXCL at 0600 (so it cannot be a planted link), fsynced, then
 * renamed over the keys file. A crash leaves the old file whole.
 */
export function setKeyInFile(name: string, value: string, path: string = KEYS_PATH): string | null {
	const v = value.trim();
	if (!SETTABLE_KEY_NAME.test(name) || name.startsWith("EIGHT_"))
		return `${name} is not a key name 8gent will write.`;
	if (v.length < MIN_SET_KEY_CHARS)
		return `That value is ${v.length} characters, too short to be a real key (need ${MIN_SET_KEY_CHARS} or more). Nothing was saved.`;
	if (!SETTABLE_KEY_VALUE.test(v) || SHELL_ACTIVE.test(v))
		return "That value has spaces, line breaks, quotes or other characters a key never has. Nothing was saved.";

	const dir = dirname(path);
	mkdirSync(dir, { recursive: true, mode: 0o700 });
	try {
		const st = lstatSync(path);
		if (st.isSymbolicLink() || !st.isFile())
			return `${path} is a link or not a regular file. Nothing was saved.`;
	} catch (e) {
		if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e;
	}
	let old: string;
	try {
		old = readNoFollow(path);
	} catch {
		return `${path} could not be read safely. Nothing was saved.`;
	}
	const kept = old.split(/\r?\n/).filter((l) => !new RegExp(`^\\s*${name}\\s*=`).test(l));
	while (kept.length && kept[kept.length - 1] === "") kept.pop();
	const body = `${[...kept, `${name}=${v}`].join("\n")}\n`;

	const tmp = join(dir, `.keys.env.${process.pid}.${randomBytes(6).toString("hex")}.tmp`);
	const fd = openSync(tmp, "wx", 0o600);
	try {
		fchmodSync(fd, 0o600);
		writeSync(fd, body);
		fsyncSync(fd);
	} catch (e) {
		closeSync(fd);
		rmSync(tmp, { force: true });
		throw e;
	}
	closeSync(fd);
	try {
		renameSync(tmp, path);
	} catch (e) {
		rmSync(tmp, { force: true });
		throw e;
	}
	return null;
}

/**
 * Merge keys file into `process.env`. Existing process.env values
 * WIN — so a shell export or CI secret always overrides the file.
 * Returns the number of keys merged.
 */
/** Env name prefixes a keys file may never set: dynamic loader and Termux exec control. */
export const LOADER_PREFIXES = ["LD_", "DYLD_", "EIGHT_TERMUX_", "TERMUX_EXEC__"];

export function loadKeysIntoEnv(path: string = KEYS_PATH): number {
	const keys = readKeysFile(path);
	let merged = 0;
	for (const [k, v] of Object.entries(keys)) {
		// The shell pass list is a per-session choice by the person at the keyboard;
		// a keys file must not be able to widen it.
		if (k.toUpperCase().startsWith("EIGHT_SHELL_ENV_")) continue;
		// Names that choose what code a process loads or which binary runs are not
		// API keys: a keys file must not be able to set them (8SO read of #4683).
		if (LOADER_PREFIXES.some((p) => k.toUpperCase().startsWith(p))) continue;
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
	const opener = platform() === "darwin" ? "open" : platform() === "win32" ? "start" : "xdg-open";
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
				`[secrets] Possible ${p} credential detected in agent output and redacted before display. Move it to ~/.8gent/keys.env via \`8gent keys set <provider>\` instead.`,
			);
		} catch {
			/* console may be patched */
		}
	}
	return redacted;
}
