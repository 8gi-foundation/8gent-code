#!/usr/bin/env bun
/**
 * Admin CLI for the audit logs. Read-only.
 *
 * Usage:
 *   bun run packages/audit/cli.ts tail  [--limit N]
 *   bun run packages/audit/cli.ts query [--target ID] [--table NAME] [--actor ID] [--since MS] [--until MS] [--limit N]
 *   bun run packages/audit/cli.ts stats
 *   bun run packages/audit/cli.ts decisions [--tool NAME] [--session ID] [--actor ID] [--decision allow|deny] [--since MS] [--until MS] [--limit N]
 *   bun run packages/audit/cli.ts verify [--ledger FILE.jsonl]
 */

import { readFileSync } from "node:fs";
import type { ChainReport } from "./hash-chain.js";
import { getAccessAuditStore, getCapabilityAuditStore, getDecisionAuditStore } from "./index.js";
// Plain JS on purpose: dependency-free so the factory can copy it out as is.
import { verifyLedger } from "./ledger-chain.mjs";
import type {
	AccessEvent,
	DecisionEvent,
	DecisionOutcome,
	QueryAccessOptions,
	QueryDecisionOptions,
} from "./types.js";

function parseArgs(argv: string[]): Record<string, string> {
	const out: Record<string, string> = {};
	for (let i = 0; i < argv.length; i++) {
		const a = argv[i];
		if (!a.startsWith("--")) continue;
		const key = a.slice(2);
		const next = argv[i + 1];
		if (!next || next.startsWith("--")) {
			out[key] = "true";
		} else {
			out[key] = next;
			i++;
		}
	}
	return out;
}

function printEvents(events: AccessEvent[]): void {
	if (events.length === 0) {
		console.log("(no events)");
		return;
	}
	for (const e of events) {
		console.log(
			[
				new Date(e.createdAt).toISOString(),
				e.operation.padEnd(6),
				`${e.actorKind}:${e.actor}`,
				`${e.targetTable}/${e.targetId}`,
				e.sessionId ? `session=${e.sessionId}` : "",
				`- ${e.reason}`,
			]
				.filter(Boolean)
				.join("  "),
		);
	}
}

function printDecisions(events: DecisionEvent[]): void {
	if (events.length === 0) {
		console.log("(no decisions)");
		return;
	}
	for (const e of events) {
		console.log(
			[
				`#${e.seq}`,
				new Date(e.createdAt).toISOString(),
				e.decision.padEnd(5),
				`[${e.gate}]`,
				`${e.actor} -> ${e.tool}`,
				`${e.requestKind}:${e.requestDetail}`,
				e.sessionId ? `session=${e.sessionId}` : "",
				`- ${e.reason}`,
			]
				.filter(Boolean)
				.join("  "),
		);
	}
}

function reportLine(name: string, r: ChainReport): string {
	if (r.ok) {
		const pre = r.preChain > 0 ? `, ${r.preChain} pre-chain` : "";
		return `${name}: ok (${r.total} records${pre}), head ${r.headHash}`;
	}
	return `${name}: BROKEN at record ${r.index}: ${r.reason}`;
}

/**
 * Verify every audit chain, or one JSONL ledger with --ledger. Prints ok or
 * the first broken record per chain. Exit 0 when all ok, 2 when any is broken.
 */
function runVerify(args: Record<string, string>): number {
	if (args.ledger) {
		const r = verifyLedger(readFileSync(args.ledger, "utf8")) as ChainReport & { line?: number };
		if (r.ok) {
			console.log(reportLine(args.ledger, r));
			return 0;
		}
		console.error(`${args.ledger}: BROKEN at line ${r.line} (record ${r.index}): ${r.reason}`);
		return 2;
	}

	let broken = false;
	for (const [name, report] of [
		["access", getAccessAuditStore().verifyChain()],
		["capability", getCapabilityAuditStore().verifyChain()],
	] as const) {
		if (!report.ok) broken = true;
		(report.ok ? console.log : console.error)(reportLine(name, report));
	}
	const dec = getDecisionAuditStore().verifyChain();
	if (dec.valid) {
		console.log(`decisions: ok (${dec.entries} records), head ${dec.headHash}`);
	} else {
		broken = true;
		console.error(`decisions: BROKEN at seq ${dec.brokenAtSeq}: ${dec.reason}`);
	}
	return broken ? 2 : 0;
}

function main(): void {
	const [cmd, ...rest] = Bun.argv.slice(2);
	const args = parseArgs(rest);

	if (cmd === "decisions") {
		const opts: QueryDecisionOptions = {
			tool: args.tool,
			sessionId: args.session,
			actor: args.actor,
			decision:
				args.decision === "allow" || args.decision === "deny"
					? (args.decision as DecisionOutcome)
					: undefined,
			since: args.since ? Number(args.since) : undefined,
			until: args.until ? Number(args.until) : undefined,
			limit: args.limit ? Number(args.limit) : 50,
		};
		printDecisions(getDecisionAuditStore().queryDecisions(opts));
		return;
	}
	if (cmd === "verify") {
		process.exit(runVerify(args));
	}

	const store = getAccessAuditStore();

	if (cmd === "tail") {
		printEvents(store.queryAccess({ limit: Number(args.limit ?? "50") }));
		return;
	}
	if (cmd === "query") {
		const opts: QueryAccessOptions = {
			targetId: args.target,
			targetTable: args.table,
			actor: args.actor,
			since: args.since ? Number(args.since) : undefined,
			until: args.until ? Number(args.until) : undefined,
			limit: args.limit ? Number(args.limit) : 200,
		};
		printEvents(store.queryAccess(opts));
		return;
	}
	if (cmd === "stats") {
		console.log(`total events: ${store.count()}`);
		return;
	}
	console.error("Usage: audit <tail|query|stats|decisions|verify> [flags]");
	console.error("  tail      --limit N");
	console.error("  query     --target ID --table NAME --actor ID --since MS --until MS --limit N");
	console.error("  stats");
	console.error(
		"  decisions --tool NAME --session ID --actor ID --decision allow|deny --since MS --until MS --limit N",
	);
	console.error("  verify    [--ledger FILE.jsonl]   exit 2 when a chain is broken");
	process.exit(1);
}

main();
