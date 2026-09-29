/**
 * Flow telemetry stream - Resonant Flow Wave 1 (boardroom GO 2026-08-10).
 *
 * Passive aggregation of signals the daemon ALREADY captures: LLM latency,
 * huddle turn durations, presence transitions, notification and message
 * timestamps. ZERO new capture of the human. No content fields exist in any
 * kind, by construction.
 *
 * ACCESS RULE (docs/specs/FLOW-TELEMETRY-SCHEMA.md): every field is
 * local-only. Records append to ~/.8gent/flow/telemetry.jsonl and NEVER go
 * through the stdout emitter (Vector -> Loki ships that off-box). Nothing in
 * this stream may enter a cloud model prompt.
 *
 * DRIFT GATE: writeFlowRecord() validates strictly against the schema below.
 * A record that does not match logs loudly and is REFUSED - drift is
 * detected, never silently absorbed (live-huddle amendment 4).
 */

import { appendFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { LLMEvent } from "./events";
import { isLLMEvent } from "./events";
import { getSink, setSink, type TelemetrySink } from "./emitter";

export const FLOW_SCHEMA_VERSION = 1 as const;

export type FlowKind = "llm_latency" | "turn_audio" | "presence" | "notification" | "message";

export interface FlowBase {
	v: typeof FLOW_SCHEMA_VERSION;
	kind: FlowKind;
	/** ISO-8601 event time. */
	ts: string;
}
export interface FlowLlmLatency extends FlowBase {
	kind: "llm_latency";
	provider: string;
	model: string;
	latencyMs: number;
	channel?: string;
	sessionId?: string;
}
export interface FlowTurnAudio extends FlowBase {
	kind: "turn_audio";
	huddleId: string;
	turnId: string;
	holder: string;
	durationMs: number;
}
export interface FlowPresence extends FlowBase {
	kind: "presence";
	channelId: string;
	agentId: string;
	state: "thinking" | "idle";
}
export interface FlowNotification extends FlowBase {
	kind: "notification";
	ntype: string;
	disposition: "delivered" | "deferred";
	channel: "telegram" | "macos" | "email";
}
export interface FlowMessage extends FlowBase {
	kind: "message";
	channelId: string;
	authorId: string;
	authorKind: "human" | "agent";
}
export type FlowRecord =
	| FlowLlmLatency
	| FlowTurnAudio
	| FlowPresence
	| FlowNotification
	| FlowMessage;

/** Field spec used by BOTH the validator and the doc-drift test. */
export interface FieldSpec {
	type: "string" | "number";
	optional?: boolean;
	enum?: readonly string[];
}
export const ENVELOPE_FIELDS: Record<string, FieldSpec> = {
	v: { type: "number" },
	kind: { type: "string" },
	ts: { type: "string" },
};
export const FLOW_FIELDS: Record<FlowKind, Record<string, FieldSpec>> = {
	llm_latency: {
		provider: { type: "string" },
		model: { type: "string" },
		latencyMs: { type: "number" },
		channel: { type: "string", optional: true },
		sessionId: { type: "string", optional: true },
	},
	turn_audio: {
		huddleId: { type: "string" },
		turnId: { type: "string" },
		holder: { type: "string" },
		durationMs: { type: "number" },
	},
	presence: {
		channelId: { type: "string" },
		agentId: { type: "string" },
		state: { type: "string", enum: ["thinking", "idle"] },
	},
	notification: {
		ntype: { type: "string" },
		disposition: { type: "string", enum: ["delivered", "deferred"] },
		channel: { type: "string", enum: ["telegram", "macos", "email"] },
	},
	message: {
		channelId: { type: "string" },
		authorId: { type: "string" },
		authorKind: { type: "string", enum: ["human", "agent"] },
	},
};

export type ValidationResult = { ok: true; record: FlowRecord } | { ok: false; reason: string };

/** Strict schema check: unknown fields, missing required, wrong types, wrong version all refuse. */
export function validateFlowRecord(raw: unknown): ValidationResult {
	if (typeof raw !== "object" || raw === null || Array.isArray(raw))
		return { ok: false, reason: "record is not an object" };
	const rec = raw as Record<string, unknown>;
	if (rec.v !== FLOW_SCHEMA_VERSION)
		return { ok: false, reason: `version ${String(rec.v)} != ${FLOW_SCHEMA_VERSION}` };
	const kind = rec.kind;
	if (typeof kind !== "string" || !(kind in FLOW_FIELDS))
		return { ok: false, reason: `unknown kind ${String(kind)}` };
	if (typeof rec.ts !== "string" || Number.isNaN(Date.parse(rec.ts)))
		return { ok: false, reason: `ts is not ISO-8601: ${String(rec.ts)}` };
	const fields = FLOW_FIELDS[kind as FlowKind];
	for (const [name, spec] of Object.entries(fields)) {
		const value = rec[name];
		if (value === undefined) {
			if (spec.optional) continue;
			return { ok: false, reason: `${kind}: missing required field ${name}` };
		}
		// biome-ignore lint/suspicious/useValidTypeof: spec.type is typed `"string" | "number"` (FieldSpec), so both sides are always valid typeof results.
		if (typeof value !== spec.type)
			return { ok: false, reason: `${kind}.${name}: expected ${spec.type}, got ${typeof value}` };
		if (spec.type === "number" && !Number.isFinite(value))
			return { ok: false, reason: `${kind}.${name}: not a finite number` };
		if (spec.enum && !spec.enum.includes(value as string))
			return { ok: false, reason: `${kind}.${name}: "${String(value)}" not in [${spec.enum.join(", ")}]` };
	}
	for (const name of Object.keys(rec)) {
		if (!(name in ENVELOPE_FIELDS) && !(name in fields))
			return { ok: false, reason: `${kind}: unknown field ${name} (schema drift?)` };
	}
	return { ok: true, record: rec as unknown as FlowRecord };
}

/** Local-only store. Env override exists for tests, not for shipping off-box. */
export function flowDir(): string {
	return process.env.FLOW_TELEMETRY_DIR ?? join(homedir(), ".8gent", "flow");
}
export function flowFilePath(): string {
	return join(flowDir(), "telemetry.jsonl");
}

/**
 * Validate and append one record. Returns false (and logs loudly) on schema
 * drift - the record is NOT written. This is the only writer of the file.
 */
export function writeFlowRecord(raw: unknown): boolean {
	const result = validateFlowRecord(raw);
	if (!result.ok) {
		console.error(`[flow-telemetry] SCHEMA DRIFT - write refused: ${result.reason}`);
		return false;
	}
	mkdirSync(flowDir(), { recursive: true });
	appendFileSync(flowFilePath(), `${JSON.stringify(result.record)}\n`);
	return true;
}

/** Sweep a JSONL file for records that no longer match the schema. */
export function scanForDrift(path: string = flowFilePath()): {
	total: number;
	valid: number;
	invalid: number;
	reasons: string[];
} {
	const out = { total: 0, valid: 0, invalid: 0, reasons: [] as string[] };
	if (!existsSync(path)) return out;
	for (const line of readFileSync(path, "utf8").split("\n")) {
		if (!line.trim()) continue;
		out.total++;
		let parsed: unknown;
		try {
			parsed = JSON.parse(line);
		} catch {
			out.invalid++;
			out.reasons.push("unparseable JSON line");
			continue;
		}
		const result = validateFlowRecord(parsed);
		if (result.ok) out.valid++;
		else {
			out.invalid++;
			out.reasons.push(result.reason);
		}
	}
	return out;
}

// ── Record constructors (thin, honest mappings from existing signals) ──

const iso = (epochMs?: number): string => new Date(epochMs ?? Date.now()).toISOString();

export function flowFromLlmEvent(e: LLMEvent): FlowLlmLatency {
	const rec: FlowLlmLatency = {
		v: FLOW_SCHEMA_VERSION,
		kind: "llm_latency",
		ts: e.ts ?? iso(),
		provider: e.provider,
		model: e.model,
		latencyMs: e.latencyMs,
	};
	if (e.channel) rec.channel = e.channel;
	if (e.sessionId) rec.sessionId = e.sessionId;
	return rec;
}
export function flowNoteTurnAudio(huddleId: string, turnId: string, holder: string, durationMs: number, epochMs?: number): boolean {
	return writeFlowRecord({ v: FLOW_SCHEMA_VERSION, kind: "turn_audio", ts: iso(epochMs), huddleId, turnId, holder, durationMs });
}
export function flowNotePresence(channelId: string, agentId: string, state: "thinking" | "idle", epochMs?: number): boolean {
	return writeFlowRecord({ v: FLOW_SCHEMA_VERSION, kind: "presence", ts: iso(epochMs), channelId, agentId, state });
}
export function flowNoteNotification(ntype: string, disposition: "delivered" | "deferred", channel: "telegram" | "macos" | "email", epochMs?: number): boolean {
	return writeFlowRecord({ v: FLOW_SCHEMA_VERSION, kind: "notification", ts: iso(epochMs), ntype, disposition, channel });
}
export function flowNoteMessage(channelId: string, authorId: string, epochMs?: number): boolean {
	const authorKind = authorId.startsWith("human:") ? "human" : "agent";
	return writeFlowRecord({ v: FLOW_SCHEMA_VERSION, kind: "message", ts: iso(epochMs), channelId, authorId, authorKind });
}

// ── Passive tap on the existing telemetry sink (LLM latency mirror) ──

let tapped: { tap: TelemetrySink; inner: TelemetrySink } | null = null;

/**
 * Wrap the active telemetry sink so every LLMEvent is ALSO mirrored into the
 * local flow stream. The original sink still receives everything unchanged -
 * this adds a local reader, it never redirects the Vector/Loki path.
 * Idempotent; returns false if already installed.
 */
export function installFlowTap(): boolean {
	if (tapped) return false;
	const inner = getSink();
	const tap: TelemetrySink = {
		write(event) {
			inner.write(event);
			if (isLLMEvent(event)) writeFlowRecord(flowFromLlmEvent(event));
		},
	};
	tapped = { tap, inner };
	setSink(tap);
	return true;
}

/** Remove the tap and restore the wrapped sink (test hook). */
export function uninstallFlowTap(): void {
	if (!tapped) return;
	// Only restore if nobody swapped the sink underneath us in the meantime.
	if (getSink() === tapped.tap) setSink(tapped.inner);
	tapped = null;
}
