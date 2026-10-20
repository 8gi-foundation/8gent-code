/**
 * 8gent credit gauge (#4539). A read-only view of how much a hosted lane has
 * left, so the TUI status bar and the failover chain can see an empty key
 * before a call fails on it.
 *
 * - `refreshCredits()` asks only providers with a documented balance endpoint
 *   (today OpenRouter /api/v1/auth/key), at most once per 10 min, 3 s timeout,
 *   and never throws. The result is cached in ~/.8gent/state/credits.json.
 * - `creditStatus()` only reads that cache. No network, safe on every render.
 * - Keys are read to sign the one request and are never logged or cached.
 */

import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { readVaultKey } from "../secrets/key-vault";

export const CREDIT_REFRESH_MS = 10 * 60 * 1000;
export const CREDIT_TIMEOUT_MS = 3000;

/** Providers whose inference runs on this machine: no key, no balance. */
const LOCAL = new Set(["8gent", "ollama", "lmstudio", "llama-server", "apfel", "apple-foundation"]);

/** Env var holding each hosted provider's key (mirrors the registry's apiKeyEnv). */
const KEY_ENV: Record<string, string> = {
	openrouter: "OPENROUTER_API_KEY",
	deepseek: "DEEPSEEK_API_KEY",
	groq: "GROQ_API_KEY",
	grok: "XAI_API_KEY",
	openai: "OPENAI_API_KEY",
	anthropic: "ANTHROPIC_API_KEY",
	mistral: "MISTRAL_API_KEY",
	together: "TOGETHER_API_KEY",
	fireworks: "FIREWORKS_API_KEY",
	replicate: "REPLICATE_API_TOKEN",
};

/** Only providers with a documented balance endpoint. Everything else is "unknown". */
const BALANCE: Record<string, { url: string; parse: (body: unknown) => number | null }> = {
	openrouter: {
		url: "https://openrouter.ai/api/v1/auth/key",
		// data.limit_remaining is USD left on a capped key; null on an uncapped one.
		parse: (b) => {
			const v = (b as { data?: { limit_remaining?: unknown } })?.data?.limit_remaining;
			return typeof v === "number" && Number.isFinite(v) ? v : null;
		},
	},
};

export type CreditStatus =
	| { kind: "local" }
	| { kind: "nokey" }
	| { kind: "unknown" }
	| { kind: "empty" }
	| { kind: "amount"; usd: number; stale: boolean };

interface CacheFile {
	fetchedAt: number;
	/** USD left per provider; a provider with no number is absent. */
	remaining: Record<string, number>;
}

export interface CreditOptions {
	file?: string;
	env?: Record<string, string | undefined>;
	now?: () => number;
	readKey?: (envName: string) => string | undefined;
	fetchFn?: (url: string, init: RequestInit) => Promise<Response>;
}

export function creditsFile(): string {
	return join(homedir(), ".8gent", "state", "credits.json");
}

function readCache(file: string): CacheFile | null {
	try {
		if (!existsSync(file)) return null;
		const raw = JSON.parse(readFileSync(file, "utf-8"));
		if (typeof raw?.fetchedAt !== "number" || typeof raw?.remaining !== "object" || !raw.remaining)
			return null;
		return raw as CacheFile;
	} catch {
		return null;
	}
}

function keyFor(provider: string, o: CreditOptions): string | undefined {
	const name = KEY_ENV[provider];
	if (!name) return undefined;
	const fromEnv = (o.env ?? process.env)[name]?.trim();
	if (fromEnv) return fromEnv;
	try {
		return (o.readKey ?? readVaultKey)(name)?.trim() || undefined;
	} catch {
		return undefined;
	}
}

/** Cached credit for one provider. Reads a file at most; never touches the network. */
export function creditStatus(providerId: string, o: CreditOptions = {}): CreditStatus {
	const id = providerId.trim().toLowerCase();
	if (LOCAL.has(id)) return { kind: "local" };
	// A hosted provider we have no key mapping for: say nothing rather than guess.
	if (!KEY_ENV[id]) return { kind: "unknown" };
	if (!keyFor(id, o)) return { kind: "nokey" };
	const cache = readCache(o.file ?? creditsFile());
	const usd = cache?.remaining[id];
	if (typeof usd !== "number") return { kind: "unknown" };
	if (usd <= 0) return { kind: "empty" };
	const age = (o.now ?? Date.now)() - (cache?.fetchedAt ?? 0);
	return { kind: "amount", usd, stale: age > CREDIT_REFRESH_MS };
}

/** True when the failover chain should skip this lane: empty credit or no key. */
export function creditBlocks(providerId: string, o: CreditOptions = {}): boolean {
	const s = creditStatus(providerId, o);
	return s.kind === "empty" || s.kind === "nokey";
}

/**
 * Refresh the cache from each documented balance endpoint. Rate limited to one
 * run per CREDIT_REFRESH_MS. Never throws; a failed lookup keeps the old number.
 */
export async function refreshCredits(o: CreditOptions = {}): Promise<void> {
	try {
		const file = o.file ?? creditsFile();
		const now = (o.now ?? Date.now)();
		const prev = readCache(file);
		if (prev && now - prev.fetchedAt < CREDIT_REFRESH_MS) return;
		const doFetch = o.fetchFn ?? ((u, i) => fetch(u, i));
		const remaining: Record<string, number> = { ...(prev?.remaining ?? {}) };
		for (const [id, ep] of Object.entries(BALANCE)) {
			const key = keyFor(id, o);
			if (!key) {
				delete remaining[id];
				continue;
			}
			try {
				const res = await doFetch(ep.url, {
					headers: { Authorization: `Bearer ${key}` },
					signal: AbortSignal.timeout(CREDIT_TIMEOUT_MS),
				});
				if (!res.ok) continue;
				const usd = ep.parse(await res.json());
				if (usd === null) delete remaining[id];
				else remaining[id] = usd;
			} catch {
				// Offline or slow: keep the last known number.
			}
		}
		mkdirSync(dirname(file), { recursive: true });
		const tmp = `${file}.${process.pid}.tmp`;
		writeFileSync(tmp, JSON.stringify({ fetchedAt: now, remaining }), { mode: 0o600 });
		renameSync(tmp, file);
	} catch {
		// A gauge must never break the TUI.
	}
}

/** The status-bar text for the active provider: "local", "$3.20 left" or "credit ?". */
export function creditGaugeText(providerId: string, o: CreditOptions = {}): string {
	const s = creditStatus(providerId, o);
	switch (s.kind) {
		case "local":
			return "local";
		case "empty":
			return "$0.00 left";
		case "amount":
			return `$${s.usd.toFixed(2)} left`;
		case "nokey":
			return "no key";
		default:
			return "credit ?";
	}
}
