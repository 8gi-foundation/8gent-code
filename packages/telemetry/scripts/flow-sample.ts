/**
 * Flow telemetry readability sample - generates ~20 REAL records from logs
 * and stores that already exist, renders them human-readable, and writes:
 *
 *   ~/.8gent/flow/sample.jsonl        (validated records, JSONL)
 *   ~/.8gent/flow/SAMPLE-FOR-JAMES.md (the Chair's readability check)
 *
 * Sources (read-only): daemon stdout logs ("kind":"llm" lines), huddle
 * manifests (turn durationMs), and the table store (message timestamps).
 * NOTHING is fabricated: kinds with no historical persistence (presence,
 * notification) are stated as absent, not invented.
 *
 * Every record passes the same validateFlowRecord() drift gate the live
 * writer uses - the sample exercises the real path.
 *
 * Run: bun run packages/telemetry/scripts/flow-sample.ts
 */

import { Database } from "bun:sqlite";
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { LLMEvent } from "../events";
import {
	type FlowRecord,
	FLOW_SCHEMA_VERSION,
	flowDir,
	flowFromLlmEvent,
	validateFlowRecord,
} from "../flow-stream";

const HOME = homedir();
const iso = (epochMs: number): string => new Date(epochMs).toISOString();

// ── 1. llm_latency from daemon stdout logs (real emitter output) ──
function mineLlm(limit: number): FlowRecord[] {
	const out: FlowRecord[] = [];
	for (const log of ["daemon.launchd.out.log", "daemon.stdout.log"]) {
		const path = join(HOME, ".8gent", log);
		if (!existsSync(path)) continue;
		for (const line of readFileSync(path, "utf8").split("\n")) {
			if (!line.includes('"kind":"llm"')) continue;
			try {
				const event = JSON.parse(line.slice(line.indexOf("{"))) as LLMEvent;
				if (event.kind === "llm") out.push(flowFromLlmEvent(event));
			} catch {
				/* non-JSON log line - skip */
			}
		}
	}
	return out.sort((a, b) => Date.parse(b.ts) - Date.parse(a.ts)).slice(0, limit);
}

// ── 2. turn_audio from huddle manifests (real measured narration) ──
interface Manifest {
	huddleId: string;
	openedAt: number;
	turns?: { turnId: string; holder: string; durationMs?: number; audioOffsetMs?: number; audioPath?: string }[];
}
function mineTurns(limit: number): FlowRecord[] {
	const root = join(HOME, ".8gent", "huddles");
	if (!existsSync(root)) return [];
	const manifests: Manifest[] = [];
	for (const dir of readdirSync(root)) {
		const path = join(root, dir, "manifest.json");
		if (!existsSync(path)) continue;
		try {
			manifests.push(JSON.parse(readFileSync(path, "utf8")) as Manifest);
		} catch {
			/* unreadable manifest - skip */
		}
	}
	manifests.sort((a, b) => (b.openedAt ?? 0) - (a.openedAt ?? 0));
	const out: FlowRecord[] = [];
	for (const m of manifests) {
		for (const t of m.turns ?? []) {
			if (out.length >= limit) return out;
			if (typeof t.durationMs !== "number" || t.durationMs <= 0) continue;
			// Only MEASURED narration: turns without an audio file carry a
			// fallback duration (uniform 3500ms), which is not a measurement.
			if (!t.audioPath || !existsSync(t.audioPath)) continue;
			out.push({
				v: FLOW_SCHEMA_VERSION,
				kind: "turn_audio",
				ts: iso((m.openedAt ?? 0) + (t.audioOffsetMs ?? 0)),
				huddleId: m.huddleId,
				turnId: t.turnId,
				holder: t.holder,
				durationMs: t.durationMs,
			});
		}
	}
	return out;
}

// ── 3. message timestamps from the table store (content NEVER read out) ──
function mineMessages(limit: number): FlowRecord[] {
	const path = join(HOME, ".8gent", "table", "table.db");
	if (!existsSync(path)) return [];
	const db = new Database(path, { readonly: true });
	try {
		const rows = db
			.query<{ channel_id: string; author_id: string; created_at: number }, [number]>(
				"SELECT channel_id, author_id, created_at FROM messages ORDER BY created_at DESC LIMIT ?",
			)
			.all(limit);
		return rows.map((r) => ({
			v: FLOW_SCHEMA_VERSION,
			kind: "message" as const,
			ts: iso(r.created_at),
			channelId: r.channel_id,
			authorId: r.author_id,
			authorKind: r.author_id.startsWith("human:") ? ("human" as const) : ("agent" as const),
		}));
	} finally {
		db.close();
	}
}

// ── Render ──
function describe(r: FlowRecord): string {
	const when = new Date(r.ts).toLocaleString("en-IE", { dateStyle: "medium", timeStyle: "short" });
	switch (r.kind) {
		case "llm_latency":
			return `${when} - a model call (${r.model} via ${r.provider}${r.channel ? `, ${r.channel} channel` : ""}) took ${(r.latencyMs / 1000).toFixed(2)}s.`;
		case "turn_audio":
			return `${when} - ${r.holder.replace("agent:", "")} spoke for ${(r.durationMs / 1000).toFixed(1)}s in huddle ${r.huddleId.slice(0, 15)}...`;
		case "presence":
			return `${when} - ${r.agentId.replace("agent:", "")} went ${r.state} in channel ${r.channelId}.`;
		case "notification":
			return `${when} - a ${r.ntype} notification was ${r.disposition} via ${r.channel}.`;
		case "message":
			return `${when} - ${r.authorKind === "human" ? "you" : r.authorId.replace("agent:", "officer ")} posted a message in channel ${r.channelId.slice(0, 13)}... (timestamp only - content is never in this stream).`;
	}
}

function main(): void {
	const records = [...mineLlm(8), ...mineTurns(6), ...mineMessages(6)];
	let refused = 0;
	const valid: FlowRecord[] = [];
	for (const r of records) {
		const check = validateFlowRecord(r);
		if (check.ok) valid.push(check.record);
		else {
			refused++;
			console.error(`[flow-sample] drift gate refused a mined record: ${check.reason}`);
		}
	}

	mkdirSync(flowDir(), { recursive: true });
	writeFileSync(join(flowDir(), "sample.jsonl"), `${valid.map((r) => JSON.stringify(r)).join("\n")}\n`);

	const byKind = new Map<string, FlowRecord[]>();
	for (const r of valid) byKind.set(r.kind, [...(byKind.get(r.kind) ?? []), r]);

	const md: string[] = [
		"# Flow telemetry - readability sample for the Chair",
		"",
		`Generated ${new Date().toISOString()} from REAL existing logs (daemon stdout, huddle manifests, table store). Nothing fabricated, nothing new captured. Schema: \`docs/specs/FLOW-TELEMETRY-SCHEMA.md\` v${FLOW_SCHEMA_VERSION} in 8gent-code.`,
		"",
		`**${valid.length} records.** Every one passed the schema-drift gate (${refused} refused). Every field is local-only: this stream never leaves the machine and never enters a cloud model prompt.`,
		"",
		"**Honest gaps:** `presence` transitions and `notification` dispatches are not persisted anywhere today (in-memory broadcast / fire-and-forget), so no historical records exist to sample - their first real records arrive when the live tap ships. The `deferred` count is honestly zero until flow mode exists.",
		"",
	];
	for (const [kind, rs] of byKind) {
		md.push(`## ${kind} (${rs.length})`, "");
		for (const r of rs) md.push(`- ${describe(r)}`, `  \`\`\`json`, `  ${JSON.stringify(r)}`, `  \`\`\``);
		md.push("");
	}
	md.push("---", "", "Approve or amend before go-live: this sample IS the readability staging gate from the 2026-08-10 live huddle (amendment 3).");
	writeFileSync(join(flowDir(), "SAMPLE-FOR-JAMES.md"), md.join("\n"));

	console.log(`[flow-sample] wrote ${valid.length} records (${refused} refused) to ${flowDir()}`);
	for (const [kind, rs] of byKind) console.log(`  ${kind}: ${rs.length}`);
}

main();
