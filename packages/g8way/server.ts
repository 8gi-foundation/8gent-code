/**
 * @8gent/g8way - Server factory.
 *
 * `createApp()` builds a Hono app wired with auth, rate limit, OpenRouter
 * client, and the OpenAI-compatible routes. Tests use it with injected
 * fakes; the bin entry point uses it with real defaults.
 */

import { Hono } from "hono";
import { clerkAuth } from "./auth";
import type { AuthMiddlewareOptions } from "./auth";
import { resolveConfig } from "./config";
import { OpenRouterClient } from "./openrouter";
import { RateLimiter } from "./rate-limit";
import { registerChatRoute } from "./routes/chat";
import { registerHealthRoute } from "./routes/health";
import { registerModelsRoute } from "./routes/models";
import type { G8wayConfig } from "./types";
import { type UsageLogger, createStdoutLogger } from "./usage";

export interface CreateAppOptions {
	config?: Partial<G8wayConfig>;
	logger?: UsageLogger;
	openrouterFetch?: typeof fetch;
	authVerify?: AuthMiddlewareOptions["verify"];
	limiter?: RateLimiter;
}

export interface BuiltApp {
	app: Hono;
	config: G8wayConfig;
	limiter: RateLimiter;
	logger: UsageLogger;
}

export function createApp(opts: CreateAppOptions = {}): BuiltApp {
	const config = resolveConfig(opts.config);
	const logger = opts.logger ?? createStdoutLogger();
	const limiter = opts.limiter ?? new RateLimiter(config.rateLimits);
	const openrouter = new OpenRouterClient({
		apiKey: config.openrouterApiKey,
		baseUrl: config.openrouterBaseUrl,
		fetchImpl: opts.openrouterFetch,
		referer: "https://8gentos.com",
		title: "g8way",
	});

	const app = new Hono();

	registerHealthRoute(app);

	const auth = clerkAuth({
		clerkFrontendApi: config.clerkFrontendApi,
		clerkPublishableKey: config.clerkPublishableKey,
		requireAuth: config.requireAuth,
		verify: opts.authVerify,
	});

	const v1 = new Hono();
	v1.use("*", auth);
	registerModelsRoute(v1, config);
	registerChatRoute(v1, { config, openrouter, limiter, logger });
	app.route("/", v1);

	app.notFound((c) =>
		c.json(
			{ error: { message: "Not found", type: "invalid_request_error", code: "not_found" } },
			404,
		),
	);

	return { app, config, limiter, logger };
}

export interface StartServerResult {
	port: number;
	stop(): void;
}

export function startServer(opts: CreateAppOptions = {}): StartServerResult {
	const built = createApp(opts);
	const port = built.config.port;

	const server = Bun.serve({
		port,
		fetch: built.app.fetch,
		idleTimeout: 240,
	});

	return {
		port: typeof server.port === "number" ? server.port : port,
		stop() {
			server.stop(true);
		},
	};
}
