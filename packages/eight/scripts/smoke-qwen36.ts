#!/usr/bin/env bun
/**
 * Smoke test: Qwen 3.6-27B vision/tool tier.
 *
 * Pulls a tiny PNG (8x8 solid-colour, generated in-process) and asks the model
 * to describe it. Pass condition: response contains non-empty text.
 *
 * Backend selection:
 *   QWEN_BACKEND=ollama   (default; uses OllamaClient at OLLAMA_URL)
 *   QWEN_BACKEND=lmstudio (uses LMStudioClient at LM_STUDIO_HOST)
 *
 * Exit codes:
 *   0 = got a non-empty response
 *   1 = endpoint down or model not pulled
 */

import { LMStudioClient } from "../clients/lmstudio";
import { OllamaClient } from "../clients/ollama";
import { getModel } from "../registry";

const QWEN_ID = "qwen3.6:27b";

// 8x8 solid red PNG, base64.
const TINY_PNG_BASE64 =
	"iVBORw0KGgoAAAANSUhEUgAAAAgAAAAIAQMAAAD+wSzIAAAAGFBMVEX/AAD///8A" +
	"AP8AAQAAAACx7g3OAAAAAXRSTlMAQObYZgAAABNJREFUCB1jYBgFo2AUjIJRQAQA" +
	"BAEAATXEMHQAAAAASUVORK5CYII=";

async function main() {
	const entry = getModel(QWEN_ID);
	if (!entry) {
		console.error(`[smoke-qwen36] FAIL: ${QWEN_ID} not in registry`);
		process.exit(1);
	}
	console.log(
		`[smoke-qwen36] model=${entry.id} provider=${entry.provider} context=${entry.context}`,
	);

	const backend = process.env.QWEN_BACKEND || "ollama";
	const client =
		backend === "lmstudio"
			? new LMStudioClient(QWEN_ID)
			: new OllamaClient(QWEN_ID);

	const reachable = await client.isAvailable();
	if (!reachable) {
		console.error(
			`[smoke-qwen36] backend ${backend} not reachable. Install: \`ollama pull ${QWEN_ID}\` (Ollama 0.6.2+) or load the GGUF in LM Studio 0.4.12+.`,
		);
		process.exit(1);
	}

	try {
		const response = await client.chat([
			{
				role: "user",
				content: [
					{ type: "text", text: "Describe this image in one short phrase." },
					{
						type: "image_url",
						image_url: { url: `data:image/png;base64,${TINY_PNG_BASE64}` },
					},
				],
			},
		]);
		const content = response.message.content || "";
		if (!content.trim()) {
			console.error("[smoke-qwen36] FAIL: empty response");
			process.exit(1);
		}
		console.log(`[smoke-qwen36] vision response: ${content.slice(0, 200)}`);
		console.log("[smoke-qwen36] OK");
		process.exit(0);
	} catch (err) {
		const msg = (err as Error).message;
		if (/not found|bad request/i.test(msg)) {
			console.error(
				`[smoke-qwen36] FAIL: ${msg}\n` +
					`Hint: pull the model with \`ollama pull ${QWEN_ID}\` (Ollama 0.6.2+).`,
			);
		} else {
			console.error(`[smoke-qwen36] FAIL: ${msg}`);
		}
		process.exit(1);
	}
}

main().catch((err) => {
	console.error(`[smoke-qwen36] crashed: ${err}`);
	process.exit(1);
});
