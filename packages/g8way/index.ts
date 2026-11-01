/**
 * @8gent/g8way - Public API.
 *
 * Lotus-class model proxy: OpenAI-compatible HTTP gateway with Clerk
 * JWT auth, per-tenant rate limiting, OpenRouter routing, and
 * structured stdout usage logging.
 */

export { createApp, startServer } from "./server";
export type { CreateAppOptions, BuiltApp, StartServerResult } from "./server";
export { clerkAuth, getTenant } from "./auth";
export { RateLimiter } from "./rate-limit";
export { createStdoutLogger, InMemoryUsageLogger } from "./usage";
export type { UsageLogger } from "./usage";
export { resolveConfig } from "./config";
export type {
	G8wayConfig,
	RateLimitConfig,
	TenantContext,
	UsageRecord,
	OpenAIChatRequest,
	OpenAIChatResponse,
	OpenAIChatMessage,
	OpenAIModelList,
} from "./types";
