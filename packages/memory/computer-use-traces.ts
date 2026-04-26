/** Computer-use trace capture (Phase 4). Local-only; not synced. 8gi:200-exempt */

import { Database } from "bun:sqlite";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { safeJsonParse, safeJsonStringify } from "./json-guard.js";
import { generateId } from "./types.js";

export type TraceOutcome = "ok" | "error" | "timeout" | "aborted";
export type PerceptionKind = "tree" | "screenshot" | "none";

export interface TraceStartParams {
	sessionId: string;
	channel: string;
	intent: string;
}

export interface TraceCloseParams {
	outcome: TraceOutcome;
	summary?: string | null;
}

export interface AppendStepParams {
	perceptionKind: PerceptionKind;
	screenshotPath?: string | null;
	toolCallName?: string | null;
	toolCallArgs?: unknown;
	toolResult?: unknown;
	tokensUsed?: number;
	ms?: number;
}

export interface TraceRow {
	id: string;
	sessionId: string;
	channel: string;
	intent: string;
	startedAt: number;
	endedAt: number | null;
	outcome: TraceOutcome | null;
	stepCount: number;
	summary: string | null;
}

export interface TraceStepRow {
	id: string;
	traceId: string;
	stepIndex: number;
	perceptionKind: PerceptionKind;
	screenshotPath: string | null;
	toolCallName: string | null;
	toolCallArgs: unknown;
	toolResult: unknown;
	tokensUsed: number;
	ms: number;
	createdAt: number;
}

export interface FullTrace extends TraceRow {
	steps: TraceStepRow[];
}

const MIGRATION_SQL = fs.readFileSync(
	path.join(import.meta.dir, "migrations", "001-traces.sql"),
	"utf-8",
);

export function defaultTracesDir(): string {
	return (
		process.env.EIGHT_TRACE_DIR ||
		path.join(os.homedir(), "Library", "Application Support", "8gent", "traces")
	);
}

export class ComputerUseTraceStore {
	readonly db: Database;
	readonly tracesDir: string;

	constructor(dbPath: string, options?: { tracesDir?: string }) {
		this.db = new Database(dbPath, { create: true });
		try {
			this.db.exec("PRAGMA journal_mode = WAL");
			this.db.exec("PRAGMA foreign_keys = ON");
		} catch {}
		this.db.exec(MIGRATION_SQL);
		this.tracesDir = options?.tracesDir ?? defaultTracesDir();
		fs.mkdirSync(this.tracesDir, { recursive: true });
	}

	startTrace(params: TraceStartParams): string {
		const id = generateId("trc");
		const now = Date.now();
		this.db
			.prepare(
				`INSERT INTO computer_use_traces
         (id, session_id, channel, intent, started_at, ended_at, outcome, step_count, summary)
         VALUES (?, ?, ?, ?, ?, NULL, NULL, 0, NULL)`,
			)
			.run(id, params.sessionId, params.channel, params.intent, now);
		fs.mkdirSync(path.join(this.tracesDir, params.sessionId), {
			recursive: true,
		});
		return id;
	}

	appendStep(traceId: string, step: AppendStepParams): string {
		const id = generateId("trs");
		const now = Date.now();
		const tx = this.db.transaction(() => {
			const next = this.db
				.prepare(
					`SELECT COALESCE(MAX(step_index), -1) + 1 AS next_index
           FROM computer_use_trace_steps WHERE trace_id = ?`,
				)
				.get(traceId) as { next_index: number };
			this.db
				.prepare(
					`INSERT INTO computer_use_trace_steps
           (id, trace_id, step_index, perception_kind, screenshot_path,
            tool_call_name, tool_call_args, tool_result, tokens_used, ms, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
				)
				.run(
					id,
					traceId,
					next.next_index,
					step.perceptionKind,
					step.screenshotPath ?? null,
					step.toolCallName ?? null,
					step.toolCallArgs === undefined
						? null
						: safeJsonStringify(step.toolCallArgs),
					step.toolResult === undefined
						? null
						: safeJsonStringify(step.toolResult),
					step.tokensUsed ?? 0,
					step.ms ?? 0,
					now,
				);
			this.db
				.prepare(
					"UPDATE computer_use_traces SET step_count = step_count + 1 WHERE id = ?",
				)
				.run(traceId);
		});
		tx();
		return id;
	}

	closeTrace(traceId: string, params: TraceCloseParams): void {
		this.db
			.prepare(
				`UPDATE computer_use_traces
         SET outcome = ?, summary = ?, ended_at = ?
         WHERE id = ?`,
			)
			.run(params.outcome, params.summary ?? null, Date.now(), traceId);
	}

	getTrace(traceId: string): FullTrace | null {
		const row = this.db
			.prepare("SELECT * FROM computer_use_traces WHERE id = ?")
			.get(traceId) as Record<string, unknown> | null;
		if (!row) return null;
		const stepRows = this.db
			.prepare(
				"SELECT * FROM computer_use_trace_steps WHERE trace_id = ? ORDER BY step_index ASC",
			)
			.all(traceId) as Record<string, unknown>[];
		return { ...rowToTrace(row), steps: stepRows.map(rowToStep) };
	}

	listRecent(limit = 20, channel?: string): TraceRow[] {
		const sql = channel
			? "SELECT * FROM computer_use_traces WHERE channel = ? ORDER BY started_at DESC LIMIT ?"
			: "SELECT * FROM computer_use_traces ORDER BY started_at DESC LIMIT ?";
		const rows = (
			channel
				? this.db.prepare(sql).all(channel, limit)
				: this.db.prepare(sql).all(limit)
		) as Record<string, unknown>[];
		return rows.map(rowToTrace);
	}

	purgeOlderThan(cutoffMs: number): { traces: number; files: number } {
		const old = this.db
			.prepare(
				"SELECT id, session_id FROM computer_use_traces WHERE started_at < ?",
			)
			.all(cutoffMs) as { id: string; session_id: string }[];
		let files = 0;
		for (const t of old) {
			const dir = path.join(this.tracesDir, t.session_id);
			if (fs.existsSync(dir)) {
				for (const f of fs.readdirSync(dir)) {
					fs.rmSync(path.join(dir, f), { force: true });
					files++;
				}
			}
		}
		const res = this.db
			.prepare("DELETE FROM computer_use_traces WHERE started_at < ?")
			.run(cutoffMs);
		return { traces: Number(res.changes ?? 0), files };
	}

	close(): void {
		this.db.close();
	}
}

function rowToTrace(r: Record<string, unknown>): TraceRow {
	return {
		id: String(r.id),
		sessionId: String(r.session_id),
		channel: String(r.channel),
		intent: String(r.intent),
		startedAt: Number(r.started_at),
		endedAt: r.ended_at == null ? null : Number(r.ended_at),
		outcome: (r.outcome as TraceOutcome | null) ?? null,
		stepCount: Number(r.step_count ?? 0),
		summary: (r.summary as string | null) ?? null,
	};
}

function rowToStep(r: Record<string, unknown>): TraceStepRow {
	return {
		id: String(r.id),
		traceId: String(r.trace_id),
		stepIndex: Number(r.step_index),
		perceptionKind: r.perception_kind as PerceptionKind,
		screenshotPath: (r.screenshot_path as string | null) ?? null,
		toolCallName: (r.tool_call_name as string | null) ?? null,
		toolCallArgs:
			r.tool_call_args == null ? null : safeJsonParse(String(r.tool_call_args)),
		toolResult:
			r.tool_result == null ? null : safeJsonParse(String(r.tool_result)),
		tokensUsed: Number(r.tokens_used ?? 0),
		ms: Number(r.ms ?? 0),
		createdAt: Number(r.created_at),
	};
}

export function defaultTraceDbPath(): string {
	const base = process.env.EIGHT_DATA_DIR || path.join(os.homedir(), ".8gent");
	const dir = path.join(base, "memory");
	fs.mkdirSync(dir, { recursive: true });
	return path.join(dir, "computer-use-traces.db");
}
