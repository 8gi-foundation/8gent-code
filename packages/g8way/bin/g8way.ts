#!/usr/bin/env bun
/**
 * @8gent/g8way - bin entry point.
 *
 * Boots the proxy on the configured port. Caddy reverse proxies
 * api.8gentos.com -> http://127.0.0.1:8080 in front of this.
 */

import { startServer } from "../server";

function requireEnv(name: string): string {
	const v = process.env[name];
	if (!v) {
		console.error(`g8way: ${name} is required`);
		process.exit(1);
	}
	return v;
}

if (process.env.G8WAY_REQUIRE_AUTH !== "false") {
	requireEnv("OPENROUTER_API_KEY");
	requireEnv("CLERK_PUBLISHABLE_KEY");
}

const { port, stop } = startServer();

console.log(
	JSON.stringify({
		ts: new Date().toISOString(),
		type: "g8way.boot",
		port,
		require_auth: process.env.G8WAY_REQUIRE_AUTH !== "false",
	}),
);

const shutdown = (signal: string) => {
	console.log(
		JSON.stringify({ ts: new Date().toISOString(), type: "g8way.shutdown", signal }),
	);
	stop();
	process.exit(0);
};

process.on("SIGINT", () => shutdown("SIGINT"));
process.on("SIGTERM", () => shutdown("SIGTERM"));
