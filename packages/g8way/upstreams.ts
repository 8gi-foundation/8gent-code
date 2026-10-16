/**
 * @8gent/g8way - Config-driven upstreams.
 *
 * G8WAY_UPSTREAMS (JSON array, operator-set env) adds upstreams beyond
 * OpenRouter. A request is routed by the longest matching model prefix;
 * unmatched models, and an unset env, keep using OpenRouter exactly as before.
 *
 *   [{ "name": "lmstudio", "baseUrl": "http://127.0.0.1:1234/v1", "prefixes": ["local/"] },
 *    { "name": "lab", "baseUrl": "https://api.example.com/v1", "prefixes": ["lab/"],
 *      "keysEnv": "LAB_API_KEYS" }]
 *
 * Security rules, each enforced below and covered in __tests__/upstreams.test.ts:
 *  - Keys come only from the environment variable named by `keysEnv` (comma
 *    separated pool). A literal key in the JSON is rejected. Keys are never
 *    logged and never put in an error message.
 *  - baseUrl is read here, once, from operator config. Nothing in a request
 *    can choose or alter it.
 *  - A non-loopback upstream is hosted: it needs EIGHT_ALLOW_HOSTED=1 (the
 *    same gate as providers/failover.ts hostedAllowed) and at least one key.
 *  - Bad config throws at startup. It never silently falls back.
 *
 * Failover: keys rotate round-robin. A 429 puts that key on cooldown and the
 * same request retries on the next key. No new listener, no new dependency.
 */

import { OpenRouterClient, type UpstreamResponse } from "./openrouter";
import type { OpenAIChatRequest } from "./types";

const COOLDOWN_MS = 60_000;
const LOOPBACK = new Set(["localhost", "127.0.0.1", "::1", "[::1]"]);

export interface UpstreamTarget {
	name: string;
	chatCompletions(req: OpenAIChatRequest): Promise<UpstreamResponse>;
}

export interface UpstreamRouter {
	/** The upstream for this model, or null to use the default OpenRouter path. */
	resolve(model: string): UpstreamTarget | null;
}

interface RawUpstream {
	name?: unknown;
	baseUrl?: unknown;
	prefixes?: unknown;
	keysEnv?: unknown;
	[key: string]: unknown;
}

interface Entry extends UpstreamTarget {
	prefixes: string[];
}

/** A redirect would carry the bearer key to another host, so redirects are errors. */
function noRedirect(base: typeof fetch = fetch): typeof fetch {
	return ((input: unknown, init?: RequestInit) =>
		base(input as never, { ...init, redirect: "error" })) as unknown as typeof fetch;
}

class KeyPool {
	private next = 0;
	private coolUntil: number[];
	constructor(
		private clients: OpenRouterClient[],
		private now: () => number,
	) {
		this.coolUntil = clients.map(() => 0);
	}

	async send(req: OpenAIChatRequest): Promise<UpstreamResponse> {
		const n = this.clients.length;
		let last: UpstreamResponse | null = null;
		for (let i = 0; i < n; i++) {
			const idx = (this.next + i) % n;
			if (this.coolUntil[idx] > this.now()) continue;
			const res = await this.clients[idx].chatCompletions(req);
			if (res.status === 429) {
				await res.body?.cancel();
				this.coolUntil[idx] = this.now() + COOLDOWN_MS;
				last = res;
				continue;
			}
			this.next = (idx + 1) % n;
			return res;
		}
		if (last) return last;
		// every key is cooling down: one honest 429, no upstream call
		return {
			status: 429,
			headers: new Headers({ "content-type": "application/json" }),
			body: null,
			json: { error: { message: "All upstream keys are cooling down", type: "rate_limit_error" } },
		};
	}
}

function parseEntry(
	raw: RawUpstream,
	env: Record<string, string | undefined>,
	fetchImpl: typeof fetch | undefined,
	now: () => number,
): Entry {
	const name = typeof raw.name === "string" ? raw.name.trim() : "";
	if (!name || name === "openrouter")
		throw new Error("G8WAY_UPSTREAMS: each upstream needs a unique name other than openrouter");
	if ("apiKey" in raw || "key" in raw || "keys" in raw) {
		throw new Error(`G8WAY_UPSTREAMS: "${name}" must not hold keys in JSON, use keysEnv`);
	}
	let url: URL;
	try {
		url = new URL(String(raw.baseUrl));
	} catch {
		throw new Error(`G8WAY_UPSTREAMS: "${name}" has an invalid baseUrl`);
	}
	if (url.protocol !== "http:" && url.protocol !== "https:") {
		throw new Error(`G8WAY_UPSTREAMS: "${name}" baseUrl must be http or https`);
	}
	if (!LOOPBACK.has(url.hostname) && url.protocol !== "https:") {
		throw new Error(`G8WAY_UPSTREAMS: "${name}" baseUrl must be https unless it is loopback`);
	}
	const prefixes = Array.isArray(raw.prefixes)
		? raw.prefixes.filter((p): p is string => typeof p === "string" && p.length > 0)
		: [];
	if (prefixes.length === 0)
		throw new Error(`G8WAY_UPSTREAMS: "${name}" needs at least one prefix`);

	const keys =
		typeof raw.keysEnv === "string"
			? (env[raw.keysEnv] ?? "")
					.split(",")
					.map((k) => k.trim())
					.filter(Boolean)
			: [];
	const hosted = !LOOPBACK.has(url.hostname);
	if (hosted && env.EIGHT_ALLOW_HOSTED?.trim() !== "1") {
		throw new Error(
			`G8WAY_UPSTREAMS: "${name}" is a hosted upstream and needs EIGHT_ALLOW_HOSTED=1`,
		);
	}
	if (hosted && keys.length === 0) {
		throw new Error(
			`G8WAY_UPSTREAMS: hosted upstream "${name}" needs at least one key in its keysEnv`,
		);
	}

	const baseUrl = url.toString().replace(/\/+$/, "");
	// keyless loopback upstreams (local runtimes) get a fixed placeholder, not a secret
	const pool = new KeyPool(
		(keys.length > 0 ? keys : ["local"]).map(
			(apiKey) => new OpenRouterClient({ apiKey, baseUrl, fetchImpl: noRedirect(fetchImpl) }),
		),
		now,
	);
	return { name, prefixes, chatCompletions: (req) => pool.send(req) };
}

export function loadUpstreams(
	env: Record<string, string | undefined> = process.env,
	opts: { fetchImpl?: typeof fetch; now?: () => number } = {},
): UpstreamRouter | null {
	const text = env.G8WAY_UPSTREAMS?.trim();
	if (!text) return null;
	let list: unknown;
	try {
		list = JSON.parse(text);
	} catch {
		throw new Error("G8WAY_UPSTREAMS is not valid JSON");
	}
	if (!Array.isArray(list) || list.length === 0)
		throw new Error("G8WAY_UPSTREAMS must be a non-empty array");

	const entries = list.map((r) =>
		parseEntry((r ?? {}) as RawUpstream, env, opts.fetchImpl, opts.now ?? Date.now),
	);
	if (new Set(entries.map((e) => e.name)).size !== entries.length) {
		throw new Error("G8WAY_UPSTREAMS: upstream names must be unique");
	}
	return {
		resolve(model: string): UpstreamTarget | null {
			let best: Entry | null = null;
			let bestLen = 0;
			for (const e of entries) {
				for (const p of e.prefixes) {
					if (model.startsWith(p) && p.length > bestLen) {
						best = e;
						bestLen = p.length;
					}
				}
			}
			return best;
		},
	};
}
