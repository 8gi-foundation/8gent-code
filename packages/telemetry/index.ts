/**
 * @8gent/telemetry — Per-tenant attribution telemetry.
 *
 * GATING (Wave 4): every LLM call, every vessel call, every storage
 * byte must carry `tenantId`. Without this firing across the system,
 * no tenant beyond James lights up.
 *
 * Output: structured JSON to stdout, one event per line. Vector picks
 * the lines up and ships them off-box to Loki. OpenTelemetry-compatible
 * trace/span ids are stamped on every event so a real OTel collector
 * can be plugged in later without code changes.
 *
 * Usage:
 *
 *   import { telemetry } from "@8gent/telemetry";
 *
 *   // Wrap an LLM call (auto-timed, error-tracked):
 *   const result = await telemetry.llm(
 *     { tenantId, sessionId, channel, provider: "openrouter", model: "qwen3.5:14b" },
 *     async () => {
 *       const r = await client.chat(req);
 *       return { result: r, usage: { promptTokens: r.usage.in, completionTokens: r.usage.out } };
 *     },
 *   );
 *
 *   // Or record manually after the fact:
 *   telemetry.recordLLM({ tenantId, provider, model, promptTokens, completionTokens, latencyMs });
 *   telemetry.recordVessel({ tenantId, endpoint: "/agent/chat", durationMs: 142 });
 *   telemetry.recordStorage({ tenantId, op: "write", store: "memory.db", bytes: 4096 });
 */

import * as attribution from "./attribution";

export * from "./attribution";
export * from "./events";
export * from "./otel";
export {
	type TelemetrySink,
	MemorySink,
	setSink,
	getSink,
	resetSinkToStdout,
} from "./emitter";
export { estimateCostUsd } from "./cost";

/**
 * Convenience namespace for callers that prefer
 * `telemetry.llm(...)` over named imports.
 */
export const telemetry = {
	llm: attribution.llm,
	vessel: attribution.vessel,
	storage: attribution.storage,
	recordLLM: attribution.recordLLM,
	recordVessel: attribution.recordVessel,
	recordStorage: attribution.recordStorage,
};
