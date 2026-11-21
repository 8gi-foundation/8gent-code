/**
 * Run trace: one local record of a run (gap register 8gi-governance#1108, lane 5).
 *
 * A run is one turn of an Agent. It becomes a tree of spans in the
 * OpenTelemetry shape: a root `run` span, one `model` span per model call and
 * one `tool` span per tool call. Each span is appended to
 * `<data dir>/traces/<trace id>.jsonl` when it ends, so a crashed run still
 * leaves its finished children on disk.
 *
 * Privacy: spans carry names, counts, durations and outcomes only. The API
 * takes no prompt text, tool arguments, results or file contents, so there is
 * nothing for it to leak. Attribute keys follow the OTel GenAI conventions.
 *
 * Network: none by default. Setting EIGHT_TRACE_OTLP_ENDPOINT posts the
 * finished run as OTLP/HTTP JSON to `<endpoint>/v1/traces`. Unset, nothing
 * leaves the machine. EIGHT_TRACE=off turns tracing off entirely.
 */

import {
	appendFileSync,
	existsSync,
	mkdirSync,
	readFileSync,
	readdirSync,
	statSync,
} from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { estimateCostUsd } from "./cost";
import { newSpanId, newTraceId } from "./otel";

export type SpanKind = "run" | "model" | "tool";
export type AttrValue = string | number | boolean;

export interface RunSpan {
	traceId: string;
	spanId: string;
	parentSpanId?: string;
	name: string;
	kind: SpanKind;
	/** Wall-clock Unix nanoseconds (ms precision). */
	startTimeUnixNano: number;
	endTimeUnixNano: number;
	status: "ok" | "error";
	attributes: Record<string, AttrValue>;
}

export const ATTR = {
	session: "8gent.session.id",
	officer: "8gent.officer",
	depth: "8gent.agent.depth",
	outcome: "8gent.outcome",
	provider: "gen_ai.system",
	model: "gen_ai.request.model",
	tokensIn: "gen_ai.usage.input_tokens",
	tokensOut: "gen_ai.usage.output_tokens",
	finishReason: "gen_ai.response.finish_reason",
	costUsd: "8gent.cost_usd",
	tool: "gen_ai.tool.name",
	toolCallId: "gen_ai.tool.call.id",
} as const;

export interface SpanSink {
	write(span: RunSpan): void;
}

export class MemorySpanSink implements SpanSink {
	spans: RunSpan[] = [];
	write(span: RunSpan): void {
		this.spans.push(span);
	}
}

type Env = Record<string, string | undefined>;

/** `$EIGHT_TRACE_DIR`, else `$EIGHT_DATA_DIR/traces`, else `~/.8gent/traces`. */
export function traceDir(env: Env = process.env): string {
	if (env.EIGHT_TRACE_DIR) return env.EIGHT_TRACE_DIR;
	return join(env.EIGHT_DATA_DIR || join(homedir(), ".8gent"), "traces");
}

export class FileSpanSink implements SpanSink {
	constructor(private readonly dir: string) {}
	write(span: RunSpan): void {
		mkdirSync(this.dir, { recursive: true });
		appendFileSync(join(this.dir, `${span.traceId}.jsonl`), `${JSON.stringify(span)}\n`, "utf8");
	}
}

export interface RunTraceOptions {
	sessionId: string;
	provider: string;
	model: string;
	officer?: string;
	depth?: number;
	sink: SpanSink;
	/** Milliseconds since epoch. Injected by tests. */
	now?: () => number;
	/** Called with the finished run's spans (the OTLP exporter). */
	onEnd?: (spans: RunSpan[]) => void;
}

interface Open {
	span: RunSpan;
}

const MS = 1_000_000;

/**
 * Records one run. Every method swallows its own errors: a trace must never
 * break the turn it is watching.
 */
export class RunTracer {
	readonly traceId = newTraceId();
	private readonly root: RunSpan;
	private readonly now: () => number;
	private readonly sink: SpanSink;
	private readonly onEnd?: (spans: RunSpan[]) => void;
	private readonly models = new Map<number, Open>();
	private readonly tools = new Map<string, Open>();
	private readonly finished: RunSpan[] = [];
	private ended = false;

	constructor(opts: RunTraceOptions) {
		this.now = opts.now ?? Date.now;
		this.sink = opts.sink;
		this.onEnd = opts.onEnd;
		const attributes: Record<string, AttrValue> = {
			[ATTR.session]: opts.sessionId,
			[ATTR.provider]: opts.provider,
			[ATTR.model]: opts.model,
		};
		if (opts.officer) attributes[ATTR.officer] = opts.officer;
		if (opts.depth !== undefined) attributes[ATTR.depth] = opts.depth;
		this.root = this.span("run", "run", undefined, attributes);
	}

	get runId(): string {
		return this.traceId;
	}

	private span(
		name: string,
		kind: SpanKind,
		parent: string | undefined,
		attributes: Record<string, AttrValue>,
	): RunSpan {
		const t = this.now() * MS;
		return {
			traceId: this.traceId,
			spanId: newSpanId(),
			parentSpanId: parent,
			name,
			kind,
			startTimeUnixNano: t,
			endTimeUnixNano: t,
			status: "ok",
			attributes,
		};
	}

	private close(span: RunSpan, endMs?: number): void {
		span.endTimeUnixNano = endMs !== undefined ? endMs * MS : this.now() * MS;
		this.finished.push(span);
		try {
			this.sink.write(span);
		} catch {
			// a full disk or read-only home must not fail the run
		}
	}

	modelStart(step: number, provider: string, model: string): void {
		if (this.ended) return;
		try {
			const open = this.models.get(step);
			if (open) this.close(open.span);
			const span = this.span(`model ${provider}/${model}`, "model", this.root.spanId, {
				[ATTR.provider]: provider,
				[ATTR.model]: model,
			});
			this.models.set(step, { span });
		} catch {}
	}

	/**
	 * Ends the model call for `step`. With no open call (a provider that does
	 * not announce its steps) a call that used tokens is still recorded.
	 */
	modelEnd(
		step: number,
		usage: { promptTokens: number; completionTokens: number },
		finishReason: string,
		durationMs?: number,
	): void {
		if (this.ended) return;
		try {
			const tokensIn = Math.max(0, usage.promptTokens | 0);
			const tokensOut = Math.max(0, usage.completionTokens | 0);
			let open = this.models.get(step);
			// Status notices ride the same event with no tokens; they are not model calls.
			if (!open && tokensIn + tokensOut === 0) return;
			if (!open) {
				const provider = String(this.root.attributes[ATTR.provider]);
				const model = String(this.root.attributes[ATTR.model]);
				open = {
					span: this.span(`model ${provider}/${model}`, "model", this.root.spanId, {
						[ATTR.provider]: provider,
						[ATTR.model]: model,
					}),
				};
			}
			this.models.delete(step);
			const a = open.span.attributes;
			a[ATTR.tokensIn] = tokensIn;
			a[ATTR.tokensOut] = tokensOut;
			a[ATTR.finishReason] = finishReason;
			a[ATTR.costUsd] = estimateCostUsd(
				String(a[ATTR.provider]),
				String(a[ATTR.model]),
				tokensIn,
				tokensOut,
			);
			if (finishReason === "error") open.span.status = "error";
			const startMs = open.span.startTimeUnixNano / MS;
			this.close(
				open.span,
				durationMs !== undefined && durationMs >= 0 ? startMs + durationMs : undefined,
			);
		} catch {}
	}

	toolStart(toolCallId: string, toolName: string): void {
		if (this.ended) return;
		try {
			const span = this.span(`tool ${toolName}`, "tool", this.root.spanId, {
				[ATTR.tool]: toolName,
				[ATTR.toolCallId]: toolCallId,
			});
			this.tools.set(toolCallId, { span });
		} catch {}
	}

	toolEnd(toolCallId: string, toolName: string, success: boolean): void {
		if (this.ended) return;
		try {
			const open = this.tools.get(toolCallId) ?? {
				span: this.span(`tool ${toolName}`, "tool", this.root.spanId, {
					[ATTR.tool]: toolName,
					[ATTR.toolCallId]: toolCallId,
				}),
			};
			this.tools.delete(toolCallId);
			open.span.status = success ? "ok" : "error";
			open.span.attributes[ATTR.outcome] = success ? "ok" : "error";
			this.close(open.span);
		} catch {}
	}

	/** Ends the run. Calls still open are closed as "unfinished". Idempotent. */
	end(outcome: string): void {
		if (this.ended) return;
		this.ended = true;
		try {
			for (const open of [...this.models.values(), ...this.tools.values()]) {
				open.span.status = "error";
				open.span.attributes[ATTR.outcome] = "unfinished";
				this.close(open.span);
			}
			this.models.clear();
			this.tools.clear();
			this.root.attributes[ATTR.outcome] = outcome;
			this.root.status = outcome === "ok" ? "ok" : "error";
			this.close(this.root);
			this.onEnd?.([...this.finished]);
		} catch {}
	}
}

// ── Factory: the default, env-driven tracer ─────────────────────────────

/**
 * A tracer writing to the local trace dir, or null when tracing is off
 * (EIGHT_TRACE=off, or under `bun test` without an explicit EIGHT_TRACE_DIR).
 */
export function startRunTrace(
	opts: Omit<RunTraceOptions, "sink" | "onEnd"> & { sink?: SpanSink },
	env: Env = process.env,
): RunTracer | null {
	try {
		const flag = (env.EIGHT_TRACE ?? "").toLowerCase();
		if (flag === "off" || flag === "0" || flag === "false") return null;
		if (!opts.sink && env.NODE_ENV === "test" && !env.EIGHT_TRACE_DIR) return null;
		const endpoint = env.EIGHT_TRACE_OTLP_ENDPOINT;
		return new RunTracer({
			...opts,
			officer: opts.officer ?? env.EIGHT_OFFICER ?? env.EIGHT_VESSEL_ROLE,
			sink: opts.sink ?? new FileSpanSink(traceDir(env)),
			onEnd: endpoint ? (spans) => void exportOtlp(spans, endpoint).catch(() => {}) : undefined,
		});
	} catch {
		return null;
	}
}

// ── OTLP/HTTP JSON exporter (opt-in only) ───────────────────────────────

function otlpValue(v: AttrValue): Record<string, unknown> {
	if (typeof v === "boolean") return { boolValue: v };
	if (typeof v === "number")
		return Number.isInteger(v) ? { intValue: String(v) } : { doubleValue: v };
	return { stringValue: v };
}

export function toOtlp(spans: RunSpan[]): Record<string, unknown> {
	return {
		resourceSpans: [
			{
				resource: { attributes: [{ key: "service.name", value: { stringValue: "8gent" } }] },
				scopeSpans: [
					{
						scope: { name: "@8gent/telemetry/run-trace" },
						spans: spans.map((s) => ({
							traceId: s.traceId,
							spanId: s.spanId,
							...(s.parentSpanId ? { parentSpanId: s.parentSpanId } : {}),
							name: s.name,
							kind: s.kind === "run" ? 1 : 3, // INTERNAL, CLIENT
							startTimeUnixNano: BigInt(Math.round(s.startTimeUnixNano)).toString(),
							endTimeUnixNano: BigInt(Math.round(s.endTimeUnixNano)).toString(),
							status: { code: s.status === "ok" ? 1 : 2 },
							attributes: Object.entries(s.attributes).map(([key, v]) => ({
								key,
								value: otlpValue(v),
							})),
						})),
					},
				],
			},
		],
	};
}

export async function exportOtlp(
	spans: RunSpan[],
	endpoint: string,
	fetchImpl: typeof fetch = fetch,
): Promise<void> {
	await fetchImpl(`${endpoint.replace(/\/+$/, "")}/v1/traces`, {
		method: "POST",
		headers: { "content-type": "application/json" },
		body: JSON.stringify(toOtlp(spans)),
	});
}

// ── Reading and showing a run ───────────────────────────────────────────

export function readRun(runId: string, dir: string = traceDir()): RunSpan[] | null {
	if (!existsSync(dir)) return null;
	const id = runId.toLowerCase();
	if (!/^[0-9a-f]{1,32}$/.test(id)) return null;
	const matches = readdirSync(dir).filter((f) => f.endsWith(".jsonl") && f.startsWith(id));
	if (matches.length !== 1) return null;
	return parseSpans(readFileSync(join(dir, matches[0]), "utf8"));
}

export function parseSpans(text: string): RunSpan[] {
	const out: RunSpan[] = [];
	for (const line of text.split("\n")) {
		if (!line.trim()) continue;
		try {
			out.push(JSON.parse(line) as RunSpan);
		} catch {
			// a torn last line from a crash
		}
	}
	return out;
}

/** The most recently written run id, or null. */
export function latestRunId(dir: string = traceDir()): string | null {
	if (!existsSync(dir)) return null;
	let best: { id: string; t: number } | null = null;
	for (const f of readdirSync(dir)) {
		if (!f.endsWith(".jsonl")) continue;
		const t = statSync(join(dir, f)).mtimeMs;
		if (!best || t > best.t) best = { id: f.slice(0, -6), t };
	}
	return best?.id ?? null;
}

export interface RunTotals {
	modelCalls: number;
	toolCalls: number;
	toolFailures: number;
	tokensIn: number;
	tokensOut: number;
	costUsd: number;
	durationMs: number;
}

export function runTotals(spans: RunSpan[]): RunTotals {
	const t: RunTotals = {
		modelCalls: 0,
		toolCalls: 0,
		toolFailures: 0,
		tokensIn: 0,
		tokensOut: 0,
		costUsd: 0,
		durationMs: 0,
	};
	let start = Number.POSITIVE_INFINITY;
	let end = Number.NEGATIVE_INFINITY;
	for (const s of spans) {
		start = Math.min(start, s.startTimeUnixNano);
		end = Math.max(end, s.endTimeUnixNano);
		if (s.kind === "model") {
			t.modelCalls++;
			t.tokensIn += Number(s.attributes[ATTR.tokensIn] ?? 0);
			t.tokensOut += Number(s.attributes[ATTR.tokensOut] ?? 0);
			t.costUsd += Number(s.attributes[ATTR.costUsd] ?? 0);
		} else if (s.kind === "tool") {
			t.toolCalls++;
			if (s.status !== "ok") t.toolFailures++;
		}
	}
	if (spans.length) t.durationMs = Math.round((end - start) / MS);
	return t;
}

function secs(span: RunSpan): string {
	return `${((span.endTimeUnixNano - span.startTimeUnixNano) / MS / 1000).toFixed(1)}s`;
}

function describe(s: RunSpan): string {
	const a = s.attributes;
	if (s.kind === "run") {
		const who = [
			a[ATTR.officer] ? `officer ${a[ATTR.officer]}` : null,
			`session ${a[ATTR.session]}`,
		]
			.filter(Boolean)
			.join("  ");
		return `run ${s.traceId}  ${who}  ${a[ATTR.outcome] ?? "unfinished"}  ${secs(s)}`;
	}
	if (s.kind === "model") {
		return `model ${a[ATTR.provider]}/${a[ATTR.model]}  in ${a[ATTR.tokensIn] ?? 0}  out ${a[ATTR.tokensOut] ?? 0}  ${secs(s)}`;
	}
	return `tool ${a[ATTR.tool]}  ${a[ATTR.outcome] ?? s.status}  ${secs(s)}`;
}

/** The run as an indented tree, children in start order, then the totals. */
export function formatRunTree(spans: RunSpan[]): string {
	const ids = new Set(spans.map((s) => s.spanId));
	const children = new Map<string | undefined, RunSpan[]>();
	for (const s of spans) {
		// A child whose parent never landed (a crash) shows at the top level.
		const parent = s.parentSpanId && ids.has(s.parentSpanId) ? s.parentSpanId : undefined;
		const list = children.get(parent) ?? [];
		list.push(s);
		children.set(parent, list);
	}
	for (const list of children.values())
		list.sort((x, y) => x.startTimeUnixNano - y.startTimeUnixNano || (x.kind === "run" ? -1 : 0));
	const lines: string[] = [];
	const walk = (parent: string | undefined, depth: number) => {
		for (const s of children.get(parent) ?? []) {
			lines.push(`${"  ".repeat(depth)}${describe(s)}`);
			walk(s.spanId, depth + 1);
		}
	};
	walk(undefined, 0);
	const t = runTotals(spans);
	lines.push("");
	lines.push(
		`totals: ${t.modelCalls} model calls, ${t.toolCalls} tool calls (${t.toolFailures} failed), ` +
			`tokens in ${t.tokensIn} out ${t.tokensOut}, est. cost $${t.costUsd.toFixed(6)}, ${(t.durationMs / 1000).toFixed(1)}s`,
	);
	return lines.join("\n");
}

/** `8gent trace show [run-id] [--json]`. No id: the latest run. Returns an exit code. */
export function traceCommand(
	args: string[],
	out: (line: string) => void = console.log,
	dir: string = traceDir(),
): number {
	const json = args.includes("--json");
	const rest = args.filter((a) => a !== "--json");
	const [sub, id] = rest;
	if (sub !== "show") {
		out("Usage: 8gent trace show [run-id] [--json]");
		return sub === undefined || sub === "help" || sub === "--help" ? 0 : 1;
	}
	const runId = id ?? latestRunId(dir);
	if (!runId) {
		out(`No runs recorded in ${dir}.`);
		return 1;
	}
	const spans = readRun(runId, dir);
	if (!spans || spans.length === 0) {
		out(`No single run matches "${runId}" in ${dir}.`);
		return 1;
	}
	out(json ? JSON.stringify({ spans, totals: runTotals(spans) }) : formatRunTree(spans));
	return 0;
}
