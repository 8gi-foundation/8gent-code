#!/usr/bin/env bun
/**
 * Smoke test: DeepSeek V4-Flash heavy cloud fallback.
 *
 * Sends a "hello" prompt and prints the first chunk of the response.
 * Reads $DEEPSEEK_API_KEY. Never logs or echoes the key.
 *
 * Set DEEPSEEK_USE_PRO=1 to exercise V4-Pro.
 *
 * Exit codes:
 *   0 = got a non-empty response
 *   1 = no API key, endpoint down, or empty response
 */

import {
	DEEPSEEK_FLASH,
	DEEPSEEK_PRO,
	DeepSeekClient,
} from "../clients/deepseek";

async function main() {
	if (!process.env.DEEPSEEK_API_KEY) {
		console.error(
			"[smoke-deepseek-v4] DEEPSEEK_API_KEY is not set. " +
				"Get a key at https://platform.deepseek.com and `export DEEPSEEK_API_KEY=...`.",
		);
		process.exit(1);
	}

	const expectedModel =
		process.env.DEEPSEEK_USE_PRO === "1" ? DEEPSEEK_PRO : DEEPSEEK_FLASH;
	console.log(`[smoke-deepseek-v4] model=${expectedModel}`);

	let client: DeepSeekClient;
	try {
		client = new DeepSeekClient();
	} catch (err) {
		console.error(`[smoke-deepseek-v4] init FAIL: ${(err as Error).message}`);
		process.exit(1);
	}

	try {
		const response = await client.chat([
			{ role: "user", content: "Say hello in one short sentence." },
		]);
		const content = response.message.content || "";
		if (!content.trim()) {
			console.error("[smoke-deepseek-v4] FAIL: empty response");
			process.exit(1);
		}
		console.log(`[smoke-deepseek-v4] response: ${content.slice(0, 200)}`);
		console.log("[smoke-deepseek-v4] OK");
		process.exit(0);
	} catch (err) {
		// Defensive: never echo the API key even if a stack trace bubbles up.
		const msg = (err as Error).message.replace(
			process.env.DEEPSEEK_API_KEY!,
			"[REDACTED]",
		);
		console.error(`[smoke-deepseek-v4] FAIL: ${msg}`);
		process.exit(1);
	}
}

main().catch((err) => {
	const msg = String(err).replace(
		process.env.DEEPSEEK_API_KEY || "__none__",
		"[REDACTED]",
	);
	console.error(`[smoke-deepseek-v4] crashed: ${msg}`);
	process.exit(1);
});
