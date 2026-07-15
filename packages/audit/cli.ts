#!/usr/bin/env bun
/**
 * Admin CLI for the audit logs. Read-only.
 *
 * Usage:
 *   bun run packages/audit/cli.ts tail  [--limit N]
 *   bun run packages/audit/cli.ts query [--target ID] [--table NAME] [--actor ID] [--since MS] [--until MS] [--limit N]
 *   bun run packages/audit/cli.ts stats
 *   bun run packages/audit/cli.ts decisions [--tool NAME] [--session ID] [--actor ID] [--decision allow|deny] [--since MS] [--until MS] [--limit N]
 *   bun run packages/audit/cli.ts verify
 */

import { getAccessAuditStore, getDecisionAuditStore } from "./index.js";
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
		const result = getDecisionAuditStore().verifyChain();
		if (result.valid) {
			console.log(`chain OK: ${result.entries} entries, head ${result.headHash}`);
			return;
		}
		console.error(`chain BROKEN at seq ${result.brokenAtSeq}: ${result.reason}`);
		process.exit(2);
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
	console.error("  verify");
	process.exit(1);
}

main();
