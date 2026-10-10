/**
 * 8gent Code - Model Failover Chains
 *
 * When a model is down, resolve to the next healthy model in the chain.
 * Chains stored in ~/.8gent/failover.json.
 *
 * Channel-aware: the `text` channel uses the legacy chain anchored on the
 * existing local default. The `computer` channel uses the chain built for
 * the 8gent Computer surface: apfel (chat) → Qwen 3.6-27B (vision/tool)
 * → DeepSeek V4-Flash (heavy cloud) → OpenRouter `:free` (last resort).
 */

import { existsSync, readFileSync } from "node:fs";
import { homedir, release } from "node:os";
import { join } from "node:path";

/**
 * Apple Foundation Model is preferred at the top of every local chain when
 * the host qualifies (macOS 26+ Tahoe on Apple Silicon with the bridge binary
 * installed). On-device, zero latency, zero cost, zero telemetry.
 */
function appleFoundationAvailable(): boolean {
	if (process.platform !== "darwin") return false;
	if (process.arch !== "arm64") return false;
	const major = Number.parseInt(release().split(".")[0] ?? "0", 10);
	if (Number.isFinite(major) && major < 25) return false;
	return existsSync(join(homedir(), ".8gent", "bin", "apple-foundation-bridge"));
}

const APPLE_FOUNDATION_ENTRY: FailoverEntry = {
	model: "apple-foundationmodel",
	provider: "apple-foundation",
};

const APFEL_ENTRY: FailoverEntry = {
	model: "apple-foundationmodel",
	provider: "apfel",
};

export type FailoverChannel = "text" | "computer";

export interface FailoverEntry {
	model: string;
	provider: string;
}

export interface FailoverChain {
	models: FailoverEntry[];
}

export interface FailoverEvent {
	ts: number;
	channel: FailoverChannel;
	fromModel: string;
	fromProvider: string;
	toModel: string;
	toProvider: string;
	reason: string;
}

/**
 * Thrown by `resolve()` when a provider allowlist is set and no allowed
 * provider can serve the model. Fail closed: never a silent cloud default.
 */
export class NoAllowedProviderError extends Error {
	constructor(
		readonly model: string,
		readonly channel: FailoverChannel,
		readonly allowed: readonly string[],
		hostedBlocked = false,
	) {
		super(
			hostedBlocked
				? `No local provider for model "${model}" (${channel} channel). Hosted providers need EIGHT_ALLOW_HOSTED=1.`
				: `No allowed provider for model "${model}" (${channel} channel). EIGHT_PROVIDERS_ALLOW=${allowed.join(",")}`,
		);
		this.name = "NoAllowedProviderError";
	}
}

/**
 * Providers whose inference runs on this machine (or on a box the user points a
 * local runtime at). Everything else is hosted.
 */
export const LOCAL_FAILOVER_PROVIDERS: readonly string[] = [
	"8gent",
	"ollama",
	"lmstudio",
	"llama-server",
	"apfel",
	"apple-foundation",
];

/** True when `provider` is not a local runtime: using it sends work off the machine. */
export function isHostedProvider(provider: string): boolean {
	return !LOCAL_FAILOVER_PROVIDERS.includes(provider.trim().toLowerCase());
}

/**
 * Hosted providers are opt-in (#3710): only EIGHT_ALLOW_HOSTED=1 lets a chain,
 * a child agent or a model lookup use or contact one.
 */
export function hostedAllowed(env: Record<string, string | undefined> = process.env): boolean {
	return env.EIGHT_ALLOW_HOSTED?.trim() === "1";
}

/** EIGHT_PROVIDERS_ALLOW as a lowercase list; null when unset or empty (no filtering). */
function allowFromEnv(): string[] | null {
	const list = (process.env.EIGHT_PROVIDERS_ALLOW ?? "")
		.split(",")
		.map((p) => p.trim().toLowerCase())
		.filter(Boolean);
	return list.length > 0 ? list : null;
}

export interface ModelFailoverOptions {
	/**
	 * Providers chains may use. Defaults to EIGHT_PROVIDERS_ALLOW; null or absent
	 * means all. An empty array allows nothing, so every resolve() throws.
	 */
	allow?: readonly string[] | null;
	/**
	 * Whether chains may use hosted providers. Defaults to EIGHT_ALLOW_HOSTED=1.
	 * Without it, hosted entries are dropped and a model with no chain throws
	 * NoAllowedProviderError instead of going to openrouter (#3710).
	 */
	allowHosted?: boolean;
}

export class ModelFailover {
	private chainsByChannel: Record<FailoverChannel, Record<string, FailoverChain>>;
	private down: Set<string> = new Set();
	private events: FailoverEvent[] = [];
	private allow: string[] | null;
	/** True when hosted providers were filtered out because there is no opt-in. */
	private hostedBlocked: boolean;

	constructor(
		chains?: Record<FailoverChannel, Record<string, FailoverChain>>,
		opts: ModelFailoverOptions = {},
	) {
		const explicit =
			opts.allow === undefined
				? allowFromEnv()
				: (opts.allow?.map((p) => p.trim().toLowerCase()) ?? null);
		this.hostedBlocked = !(opts.allowHosted ?? hostedAllowed());
		// No opt-in: the allowlist is the local providers (narrowed further by an explicit one).
		this.allow = this.hostedBlocked
			? (explicit ?? [...LOCAL_FAILOVER_PROVIDERS]).filter((p) => !isHostedProvider(p))
			: explicit;
		const loaded = chains || this.loadChains();
		this.chainsByChannel = this.allow ? this.filterChains(loaded, this.allow) : loaded;
	}

	/**
	 * Copy of `chains` keeping only entries whose provider is allowed. Malformed
	 * chains (non-array `models`) and entries (non-string `provider`) from a
	 * hand-edited failover.json are dropped, never thrown on: the chain empties
	 * and resolve() fails closed with NoAllowedProviderError.
	 */
	private filterChains(
		chains: Record<FailoverChannel, Record<string, FailoverChain>>,
		allow: string[],
	): Record<FailoverChannel, Record<string, FailoverChain>> {
		const out = { text: {}, computer: {} } as Record<
			FailoverChannel,
			Record<string, FailoverChain>
		>;
		for (const channel of Object.keys(chains) as FailoverChannel[]) {
			out[channel] = {};
			const byModel = chains[channel];
			if (!byModel || typeof byModel !== "object") continue;
			for (const [model, chain] of Object.entries(byModel)) {
				const models = Array.isArray(chain?.models) ? chain.models : [];
				out[channel][model] = {
					models: models.filter(
						(e) => typeof e?.provider === "string" && allow.includes(e.provider.toLowerCase()),
					),
				};
			}
		}
		return out;
	}

	/** The built-in chains, ignoring ~/.8gent/failover.json. */
	static defaultChains(): Record<FailoverChannel, Record<string, FailoverChain>> {
		return {
			text: ModelFailover.defaultTextChains(),
			computer: ModelFailover.defaultComputerChains(),
		};
	}

	private loadChains(): Record<FailoverChannel, Record<string, FailoverChain>> {
		try {
			const fp = join(homedir(), ".8gent", "failover.json");
			if (existsSync(fp)) {
				const raw = JSON.parse(readFileSync(fp, "utf-8"));
				// Back-compat: if the file is the old flat shape (no `text`/`computer`
				// top-level keys), treat the whole thing as the text channel.
				if (raw && typeof raw === "object" && !raw.text && !raw.computer) {
					return { text: raw, computer: ModelFailover.defaultComputerChains() };
				}
				return {
					text: raw.text || ModelFailover.defaultTextChains(),
					computer: raw.computer || ModelFailover.defaultComputerChains(),
				};
			}
		} catch {
			// Fall through to defaults.
		}

		return ModelFailover.defaultChains();
	}

	private static defaultTextChains(): Record<string, FailoverChain> {
		const preferAppleFoundation = appleFoundationAvailable();
		const prefix: FailoverEntry[] = preferAppleFoundation ? [APPLE_FOUNDATION_ENTRY] : [];

		return {
			// When openrouter/auto times out (usually because it routed to a
			// thinking model with long TTFT), fall back to a fast reliable model.
			"openrouter/auto": {
				models: [
					{ model: "openrouter/auto", provider: "openrouter" },
					{
						model: "meta-llama/llama-3.3-70b-instruct",
						provider: "openrouter",
					},
					{
						model: "meta-llama/llama-3-8b-instruct:free",
						provider: "openrouter",
					},
				],
			},
			"eight:latest": {
				models: [
					...prefix,
					{ model: "eight:latest", provider: "ollama" },
					{ model: "qwen3.5:latest", provider: "ollama" },
					{
						model: "meta-llama/llama-3-8b-instruct:free",
						provider: "openrouter",
					},
				],
			},
			"qwen3.5:latest": {
				models: [
					...prefix,
					{ model: "qwen3.5:latest", provider: "ollama" },
					{
						model: "meta-llama/llama-3-8b-instruct:free",
						provider: "openrouter",
					},
				],
			},
			"apple-foundationmodel": {
				models: [
					APPLE_FOUNDATION_ENTRY,
					{ model: "eight-1.0-q3:14b", provider: "8gent" },
					{ model: "qwen3:14b", provider: "ollama" },
					{
						model: "meta-llama/llama-3-8b-instruct:free",
						provider: "openrouter",
					},
				],
			},
			// LM Studio-loaded models. When a user has a model loaded in LM
			// Studio the failover chain must include the lmstudio provider
			// explicitly, otherwise resolve() falls through to openrouter
			// and the executor fails with "model not found". Add new
			// lmstudio-loaded model ids here as users adopt them.
			"google/gemma-4-26b-a4b": {
				models: [
					{ model: "google/gemma-4-26b-a4b", provider: "lmstudio" },
					...prefix,
					{ model: "qwen3:14b", provider: "ollama" },
					{
						model: "meta-llama/llama-3-8b-instruct:free",
						provider: "openrouter",
					},
				],
			},
		};
	}

	/**
	 * Computer channel chain: apfel (chat) → Qwen 3.6-27B (vision/tool, default
	 * brain) → DeepSeek V4-Flash (heavy cloud) → OpenRouter `:free` (last resort).
	 *
	 * Apfel handles short conversational replies (no vision). The agent is
	 * responsible for routing vision-bearing prompts past the chat tier (see
	 * `vision-router.ts`. If apfel is asked for a vision prompt, it will throw
	 * and the chain falls through to Qwen.
	 */
	private static defaultComputerChains(): Record<string, FailoverChain> {
		const computerChain: FailoverEntry[] = [
			APFEL_ENTRY,
			{ model: "qwen3.6:27b", provider: "ollama" },
			{ model: "deepseek-flash", provider: "deepseek" },
			{ model: "meta-llama/llama-3-8b-instruct:free", provider: "openrouter" },
		];

		return {
			"qwen3.6:27b": { models: computerChain },
			"apple-foundationmodel": { models: computerChain },
			"deepseek-flash": {
				models: [
					{ model: "deepseek-flash", provider: "deepseek" },
					{ model: "qwen3.6:27b", provider: "ollama" },
					{
						model: "meta-llama/llama-3-8b-instruct:free",
						provider: "openrouter",
					},
				],
			},
		};
	}

	private key(model: string, provider: string): string {
		return `${provider}::${model}`;
	}

	/**
	 * Return the first healthy model in the chain for the given channel.
	 * Defaults to the `text` channel for back-compat with existing callers.
	 *
	 * Hosted providers are opt-in (EIGHT_ALLOW_HOSTED=1). Without it, chains
	 * hold only local providers and a model with no chain throws
	 * NoAllowedProviderError. With it, a model with no chain is retried on
	 * openrouter, the free cloud tier.
	 *
	 * With an allowlist (EIGHT_PROVIDERS_ALLOW) chains hold only allowed
	 * providers, and when nothing allowed can serve the model this throws
	 * NoAllowedProviderError instead of defaulting to openrouter.
	 */
	resolve(model: string, channel: FailoverChannel = "text"): FailoverEntry {
		const chain = this.chainsByChannel[channel]?.[model];
		if (this.allow && (chain ? chain.models.length === 0 : !this.allow.includes("openrouter"))) {
			throw new NoAllowedProviderError(model, channel, this.allow, this.hostedBlocked);
		}
		if (!chain) return { model, provider: "openrouter" };

		const head = chain.models[0];
		for (const entry of chain.models) {
			if (!this.down.has(this.key(entry.model, entry.provider))) {
				if (head && (entry.model !== head.model || entry.provider !== head.provider)) {
					this.recordEvent({
						ts: Date.now(),
						channel,
						fromModel: head.model,
						fromProvider: head.provider,
						toModel: entry.model,
						toProvider: entry.provider,
						reason: "primary-down",
					});
				}
				return entry;
			}
		}

		// Everything is down - return last entry as a hail mary
		const last = chain.models[chain.models.length - 1] || {
			model,
			provider: "openrouter",
		};
		this.recordEvent({
			ts: Date.now(),
			channel,
			fromModel: head?.model ?? model,
			fromProvider: head?.provider ?? "openrouter",
			toModel: last.model,
			toProvider: last.provider,
			reason: "all-tiers-down",
		});
		return last;
	}

	/**
	 * Where the agent would go if `provider`/`model` failed right now: the
	 * entry `resolve()` returns after `markDown(model, provider)`, which is
	 * the walk `packages/eight/agent.ts` does on an error. Read-only: nothing
	 * is marked down and no event is recorded.
	 *
	 * Null when no chain is registered for the model (resolve() would only
	 * retry the same model id on openrouter) or when every other entry is
	 * already down. Display surfaces use this so a fallback they show is one
	 * the chain really holds.
	 */
	nextHop(
		model: string,
		provider: string,
		channel: FailoverChannel = "text",
	): FailoverEntry | null {
		const chain = this.chainsByChannel[channel]?.[model];
		if (!chain) return null;
		for (const entry of chain.models) {
			if (entry.model === model && entry.provider === provider) continue;
			if (this.down.has(this.key(entry.model, entry.provider))) continue;
			return entry;
		}
		return null;
	}

	markDown(model: string, provider: string): void {
		this.down.add(this.key(model, provider));
	}

	markUp(model: string, provider: string): void {
		this.down.delete(this.key(model, provider));
	}

	isDown(model: string, provider: string): boolean {
		return this.down.has(this.key(model, provider));
	}

	/** Recent failover events. Drained by the bake-off harness. */
	getEvents(): FailoverEvent[] {
		return [...this.events];
	}

	drainEvents(): FailoverEvent[] {
		const out = [...this.events];
		this.events = [];
		return out;
	}

	private recordEvent(event: FailoverEvent): void {
		this.events.push(event);
		if (process.env.FAILOVER_LOG === "1") {
			// Keep the line machine-parseable for the bake-off harness.
			process.stderr.write(`[failover] ${JSON.stringify(event)}\n`);
		}
	}
}
