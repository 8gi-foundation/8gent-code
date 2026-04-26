#!/usr/bin/env bun
/**
 * Admin CLI for the access audit log. Read-only.
 *
 * Usage:
 *   bun run packages/audit/cli.ts tail  [--limit N]
 *   bun run packages/audit/cli.ts query [--target ID] [--table NAME] [--actor ID] [--since MS] [--until MS] [--limit N]
 *   bun run packages/audit/cli.ts stats
 */

import { getAccessAuditStore } from "./index.js";
import type { AccessEvent, QueryAccessOptions } from "./types.js";

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

function main(): void {
	const [cmd, ...rest] = Bun.argv.slice(2);
	const args = parseArgs(rest);
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
	console.error("Usage: audit <tail|query|stats> [flags]");
	console.error("  tail  --limit N");
	console.error(
		"  query --target ID --table NAME --actor ID --since MS --until MS --limit N",
	);
	console.error("  stats");
	process.exit(1);
}

main();
