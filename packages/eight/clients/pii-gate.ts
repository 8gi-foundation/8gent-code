/**
 * 8gent Code - PII gate for cloud LLM clients (main-agent-loop egress boundary)
 *
 * HARD RULE: no personally-identifiable information may ever reach a cloud
 * provider. The `ProviderManager.chat()` chokepoint already enforces this, but
 * the main agent loop can dispatch through the lower-level `LLMClient`
 * implementations (`OpenRouterClient`, `DeepSeekClient`) directly - bypassing
 * that gate. This module reuses the SAME local, deterministic anonymizer
 * (`packages/permissions/pii-anonymizer.ts`) to close that bypass for cloud
 * clients only. Local clients (ollama / lmstudio / apfel / apple-foundation)
 * never call this - their data never leaves the device.
 *
 * Mirrors the providers-gate behaviour exactly:
 *   1. anonymize outbound messages (shared reverse map across the turn),
 *   2. verifyClean the pseudonymized payload BEFORE sending,
 *   3. send only pseudonyms to the cloud,
 *   4. de-anonymize the response content AND tool-call arguments on the way back,
 *   5. FAIL CLOSED on any throw or surviving-PII: reroute to a local model, or
 *      refuse - never send raw.
 *
 * This module is additive. It does NOT modify the anonymizer or the policy
 * engine; it only imports the published anonymizer surface.
 */

import {
	anonymizeMessages,
	deanonymize,
	verifyClean,
} from "../../permissions/pii-anonymizer";
import type { LLMClient, LLMResponse, Message } from "../types";
import { OllamaClient } from "./ollama";

/**
 * Local model a cloud client reroutes to when the PII gate fails closed. Ollama
 * needs no API key and keeps data on-device, so it is the safe local of last
 * resort. The model name is overridable via `PII_FALLBACK_MODEL`; the Ollama
 * base URL resolves from the client's own env defaults.
 */
export function resolveLocalFallback(): LLMClient | null {
	try {
		const model = process.env.PII_FALLBACK_MODEL || "qwen3:latest";
		return new OllamaClient(model);
	} catch {
		return null;
	}
}

/** Result of gating an outbound message list before a cloud send. */
export interface OutboundGate {
	/** Pseudonymized messages, safe to send to a cloud provider. */
	messages: Message[];
	/** Per-turn reverse map (pseudonym -> raw). Empty when nothing was masked. */
	map: Map<string, string>;
	/**
	 * True when anonymization ran and the payload verified clean. False means
	 * the caller MUST fail closed (reroute local or refuse) - never send raw.
	 */
	clean: boolean;
}

/**
 * Flatten a message's content to a string for the anonymizer, which operates on
 * `{ role, content: string }`. Image parts carry no maskable text, so we mask
 * only the text parts and rejoin. Non-string content is reduced to its text.
 */
function contentToString(content: Message["content"]): string {
	if (typeof content === "string") return content;
	return content.map((part) => (part.type === "text" ? (part.text ?? "") : "")).join("");
}

/**
 * Anonymize an outbound message list and verify the result is clean. Returns
 * `clean: false` (fail-closed signal) if the anonymizer throws or PII still
 * survives. The shared map is threaded back through `deanonymizeResponse`.
 *
 * Anonymization runs on the flattened text of each message. When a message has
 * structured (image) content we replace it with the anonymized text form, since
 * the only maskable surface is the text and the cloud must not see raw text PII.
 */
export function anonymizeOutbound(messages: Message[]): OutboundGate {
	try {
		const flat = messages.map((m) => ({
			role: m.role,
			content: contentToString(m.content),
			__orig: m,
		}));
		const gated = anonymizeMessages(flat);
		const joined = gated.messages.map((m) => m.content).join("\n");
		if (!verifyClean(joined)) {
			return { messages, map: new Map(), clean: false };
		}
		const rebuilt: Message[] = gated.messages.map((m, i) => ({
			...messages[i],
			content: m.content,
		}));
		return { messages: rebuilt, map: gated.map, clean: true };
	} catch {
		// Anonymizer unavailable / errored: cannot prove the payload is clean.
		return { messages, map: new Map(), clean: false };
	}
}

/**
 * De-anonymize a cloud `LLMResponse` so the caller sees real values. Restores
 * both the assistant content and any pseudonyms echoed into tool-call argument
 * strings (the client shape stores `function.arguments` as a JSON string).
 */
export function deanonymizeResponse(
	response: LLMResponse,
	map: Map<string, string>,
): LLMResponse {
	if (!map || map.size === 0) return response;
	const message = {
		...response.message,
		content: deanonymize(response.message.content ?? "", map),
		tool_calls: response.message.tool_calls?.map((tc) => ({
			...tc,
			function: {
				...tc.function,
				// arguments is a raw JSON string; de-anonymizing the string restores
				// any pseudonym the model echoed back, and stays valid JSON because
				// pseudonyms (`[PERSON_1]`) never contain JSON-structural characters.
				arguments: deanonymize(tc.function.arguments ?? "", map),
			},
		})),
	};
	return { ...response, message };
}
