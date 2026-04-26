/**
 * @8gent/telemetry — Attribution API
 *
 * Public surface for instrumenting LLM calls, vessel calls, and storage
 * ops with a tenantId. Gates Wave 4 multi-tenant rollout: an event
 * without tenantId is rejected before it reaches the sink.
 *
 * Two usage shapes:
 *
 *   1) Wrap an async op and let the wrapper time + emit:
 *      await telemetry.llm({ tenantId, provider, model, ... }, () => client.chat(...))
 *
 *   2) Record a finished op manually:
 *      telemetry.recordLLM({ tenantId, provider, model, promptTokens, ... })
 */

import { estimateCostUsd } from "./cost";
import { getSink } from "./emitter";
import type { LLMEvent, StorageEvent, TelemetryEvent, VesselEvent } from "./events";
import { type SpanContext, newSpanContext, nowUnixNano } from "./otel";

/** Thrown when an event is missing required attribution. */
export class TelemetryAttributionError extends Error {
	constructor(public readonly event: Partial<TelemetryEvent>) {
		super(
			`Telemetry event rejected: tenantId is required (kind=${event.kind ?? "?"}). ` +
				"Wave 4 gate — every LLM/vessel/storage op must be tenant-attributed.",
		);
		this.name = "TelemetryAttributionError";
	}
}

function ensureAttributed(event: Partial<TelemetryEvent>): void {
	if (!event.tenantId || typeof event.tenantId !== "string" || event.tenantId.length === 0) {
		throw new TelemetryAttributionError(event);
	}
}

function stamp<T extends TelemetryEvent>(event: T, span?: SpanContext): T {
	const ctx = span ?? newSpanContext();
	const now = nowUnixNano();
	const stamped: T = {
		...event,
		ts: event.ts ?? new Date().toISOString(),
		traceId: event.traceId ?? ctx.traceId,
		spanId: event.spanId ?? ctx.spanId,
		parentSpanId: event.parentSpanId ?? ctx.parentSpanId,
		startTimeUnixNano: event.startTimeUnixNano ?? ctx.startTimeUnixNano,
		endTimeUnixNano: event.endTimeUnixNano ?? now,
	};
	return stamped;
}

/* ============================================================
 * Manual record API
 * ============================================================ */

export type LLMRecord = Omit<LLMEvent, "kind" | "totalTokens" | "costUsd"> & {
	totalTokens?: number;
	costUsd?: number;
};

export function recordLLM(input: LLMRecord, span?: SpanContext): LLMEvent {
	ensureAttributed({ ...input, kind: "llm" });
	const totalTokens = input.totalTokens ?? input.promptTokens + input.completionTokens;
	const costUsd =
		input.costUsd ??
		estimateCostUsd(input.provider, input.model, input.promptTokens, input.completionTokens);
	const event: LLMEvent = stamp(
		{
			...input,
			kind: "llm",
			totalTokens,
			costUsd,
		},
		span,
	);
	getSink().write(event);
	return event;
}

export type VesselRecord = Omit<VesselEvent, "kind">;

export function recordVessel(input: VesselRecord, span?: SpanContext): VesselEvent {
	ensureAttributed({ ...input, kind: "vessel" });
	const event: VesselEvent = stamp({ ...input, kind: "vessel" }, span);
	getSink().write(event);
	return event;
}

export type StorageRecord = Omit<StorageEvent, "kind">;

export function recordStorage(input: StorageRecord, span?: SpanContext): StorageEvent {
	ensureAttributed({ ...input, kind: "storage" });
	const event: StorageEvent = stamp({ ...input, kind: "storage" }, span);
	getSink().write(event);
	return event;
}

/* ============================================================
 * Wrapper API — auto-times the operation
 * ============================================================ */

export interface LLMSpan {
	tenantId: string;
	clerkId?: string;
	sessionId?: string;
	channel?: string;
	provider: string;
	model: string;
	streamed?: boolean;
	usedTools?: boolean;
}

export interface LLMResult {
	promptTokens: number;
	completionTokens: number;
}

/**
 * Wrap an LLM call. Emits one `llm` event whether the call succeeds or
 * throws. The callback returns `{ promptTokens, completionTokens }`
 * alongside its real result so the wrapper can attribute usage.
 */
export async function llm<T>(
	span: LLMSpan,
	fn: (ctx: SpanContext) => Promise<{ result: T; usage: LLMResult }>,
): Promise<T> {
	ensureAttributed({ ...span, kind: "llm" });
	const ctx = newSpanContext();
	const startMs = Date.now();
	try {
		const { result, usage } = await fn(ctx);
		recordLLM(
			{
				tenantId: span.tenantId,
				clerkId: span.clerkId,
				sessionId: span.sessionId,
				channel: span.channel,
				provider: span.provider,
				model: span.model,
				promptTokens: usage.promptTokens,
				completionTokens: usage.completionTokens,
				latencyMs: Date.now() - startMs,
				streamed: span.streamed,
				usedTools: span.usedTools,
			},
			ctx,
		);
		return result;
	} catch (err) {
		recordLLM(
			{
				tenantId: span.tenantId,
				clerkId: span.clerkId,
				sessionId: span.sessionId,
				channel: span.channel,
				provider: span.provider,
				model: span.model,
				promptTokens: 0,
				completionTokens: 0,
				latencyMs: Date.now() - startMs,
				error: err instanceof Error ? err.message : String(err),
			},
			ctx,
		);
		throw err;
	}
}

export interface VesselSpan {
	tenantId: string;
	clerkId?: string;
	sessionId?: string;
	channel?: string;
	endpoint: string;
}

export async function vessel<T>(
	span: VesselSpan,
	fn: (ctx: SpanContext) => Promise<T>,
): Promise<T> {
	ensureAttributed({ ...span, kind: "vessel" });
	const ctx = newSpanContext();
	const startMs = Date.now();
	try {
		const result = await fn(ctx);
		recordVessel(
			{
				tenantId: span.tenantId,
				clerkId: span.clerkId,
				sessionId: span.sessionId,
				channel: span.channel,
				endpoint: span.endpoint,
				durationMs: Date.now() - startMs,
				status: 200,
			},
			ctx,
		);
		return result;
	} catch (err) {
		recordVessel(
			{
				tenantId: span.tenantId,
				clerkId: span.clerkId,
				sessionId: span.sessionId,
				channel: span.channel,
				endpoint: span.endpoint,
				durationMs: Date.now() - startMs,
				status: 500,
				error: err instanceof Error ? err.message : String(err),
			},
			ctx,
		);
		throw err;
	}
}

export interface StorageSpan {
	tenantId: string;
	clerkId?: string;
	sessionId?: string;
	op: StorageEvent["op"];
	store: string;
}

export async function storage<T>(
	span: StorageSpan,
	fn: (ctx: SpanContext) => Promise<{ result: T; bytes: number }>,
): Promise<T> {
	ensureAttributed({ ...span, kind: "storage" });
	const ctx = newSpanContext();
	const startMs = Date.now();
	try {
		const { result, bytes } = await fn(ctx);
		recordStorage(
			{
				tenantId: span.tenantId,
				clerkId: span.clerkId,
				sessionId: span.sessionId,
				op: span.op,
				store: span.store,
				bytes,
				durationMs: Date.now() - startMs,
			},
			ctx,
		);
		return result;
	} catch (err) {
		recordStorage(
			{
				tenantId: span.tenantId,
				clerkId: span.clerkId,
				sessionId: span.sessionId,
				op: span.op,
				store: span.store,
				bytes: 0,
				durationMs: Date.now() - startMs,
				error: err instanceof Error ? err.message : String(err),
			},
			ctx,
		);
		throw err;
	}
}
