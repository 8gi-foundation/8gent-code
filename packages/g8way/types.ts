/**
 * @8gent/g8way - Types
 *
 * OpenAI-compatible request/response shapes plus internal config and usage records.
 * The proxy mirrors the OpenAI Chat Completions API contract so any OpenAI SDK
 * (or LangChain, AI SDK, etc.) can point at it by changing `baseURL`.
 */

// ============================================
// OpenAI-compatible request/response
// ============================================

export interface OpenAIChatMessage {
	role: "system" | "user" | "assistant" | "tool";
	content: string | null;
	name?: string;
	tool_call_id?: string;
	tool_calls?: OpenAIToolCall[];
}

export interface OpenAIToolCall {
	id: string;
	type: "function";
	function: { name: string; arguments: string };
}

export interface OpenAIChatRequest {
	model: string;
	messages: OpenAIChatMessage[];
	temperature?: number;
	top_p?: number;
	max_tokens?: number;
	stream?: boolean;
	tools?: unknown[];
	tool_choice?: unknown;
	user?: string;
	[key: string]: unknown;
}

export interface OpenAIChatChoice {
	index: number;
	message: OpenAIChatMessage;
	finish_reason: string | null;
}

export interface OpenAIUsage {
	prompt_tokens: number;
	completion_tokens: number;
	total_tokens: number;
}

export interface OpenAIChatResponse {
	id: string;
	object: "chat.completion";
	created: number;
	model: string;
	choices: OpenAIChatChoice[];
	usage?: OpenAIUsage;
}

export interface OpenAIModel {
	id: string;
	object: "model";
	created: number;
	owned_by: string;
}

export interface OpenAIModelList {
	object: "list";
	data: OpenAIModel[];
}

// ============================================
// Tenant + auth context
// ============================================

/**
 * Resolved identity attached to every authenticated request.
 * `tenantId` is the billing/quota key. For solo users it equals the
 * Clerk user id; for orgs it would be the Clerk organization id once
 * organizations are wired in the JWT template.
 */
export interface TenantContext {
	tenantId: string;
	clerkUserId: string;
	email: string;
	plan: "free" | "pro" | "team";
}

// ============================================
// Usage record (structured stdout log)
// ============================================

/**
 * One JSON line per request, written to stdout. Vector/Loki tail this.
 * Keep keys snake_case so they survive an OTel/Loki round trip cleanly.
 */
export interface UsageRecord {
	ts: string;
	type: "g8way.usage";
	tenant_id: string;
	clerk_user_id: string;
	plan: string;
	model_requested: string;
	model_resolved: string;
	upstream: "openrouter";
	prompt_tokens: number;
	completion_tokens: number;
	total_tokens: number;
	latency_ms: number;
	status: number;
	stream: boolean;
	error?: string;
}

// ============================================
// Server config
// ============================================

export interface G8wayConfig {
	port: number;
	openrouterApiKey: string;
	openrouterBaseUrl: string;
	clerkFrontendApi: string;
	clerkPublishableKey: string;
	allowedModels: string[];
	defaultModel: string;
	rateLimits: Record<string, RateLimitConfig>;
	requireAuth: boolean;
}

export interface RateLimitConfig {
	requestsPerMinute: number;
	tokensPerMinute: number;
}
