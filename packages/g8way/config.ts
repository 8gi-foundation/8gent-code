/**
 * @8gent/g8way - Config resolution
 *
 * Pulls config from environment variables with sane defaults.
 * Per CLAUDE.md "no secrets in chat" rule: secrets only come from env.
 */

import type { G8wayConfig, RateLimitConfig } from "./types";

const ALLOWED_MODELS_DEFAULT = [
	"anthropic/claude-sonnet-4-6",
	"openai/gpt-4o",
	"google/gemini-2.0-flash-001",
];

const DEFAULT_RATE_LIMITS: Record<string, RateLimitConfig> = {
	free: { requestsPerMinute: 20, tokensPerMinute: 50_000 },
	pro: { requestsPerMinute: 200, tokensPerMinute: 500_000 },
	team: { requestsPerMinute: 1000, tokensPerMinute: 5_000_000 },
};

function envInt(name: string, fallback: number): number {
	const v = process.env[name];
	if (!v) return fallback;
	const n = Number.parseInt(v, 10);
	return Number.isFinite(n) ? n : fallback;
}

function envList(name: string, fallback: string[]): string[] {
	const v = process.env[name];
	if (!v) return fallback;
	return v
		.split(",")
		.map((s) => s.trim())
		.filter(Boolean);
}

export function resolveConfig(overrides?: Partial<G8wayConfig>): G8wayConfig {
	return {
		port: overrides?.port ?? envInt("G8WAY_PORT", 8080),
		openrouterApiKey: overrides?.openrouterApiKey ?? process.env.OPENROUTER_API_KEY ?? "",
		openrouterBaseUrl:
			overrides?.openrouterBaseUrl ??
			process.env.OPENROUTER_BASE_URL ??
			"https://openrouter.ai/api/v1",
		clerkFrontendApi:
			overrides?.clerkFrontendApi ?? process.env.CLERK_FRONTEND_API ?? "https://clerk.8gent.app",
		clerkPublishableKey: overrides?.clerkPublishableKey ?? process.env.CLERK_PUBLISHABLE_KEY ?? "",
		allowedModels:
			overrides?.allowedModels ?? envList("G8WAY_ALLOWED_MODELS", ALLOWED_MODELS_DEFAULT),
		defaultModel:
			overrides?.defaultModel ?? process.env.G8WAY_DEFAULT_MODEL ?? "anthropic/claude-sonnet-4-6",
		rateLimits: overrides?.rateLimits ?? DEFAULT_RATE_LIMITS,
		requireAuth:
			overrides?.requireAuth ??
			(process.env.G8WAY_REQUIRE_AUTH ?? "true").toLowerCase() !== "false",
	};
}
