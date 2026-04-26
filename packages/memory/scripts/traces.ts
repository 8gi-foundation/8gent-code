#!/usr/bin/env bun
/** Trace viewer CLI: list / show / replay / purge. */

import {
	ComputerUseTraceStore,
	type TraceStepRow,
	defaultTraceDbPath,
} from "../computer-use-traces.js";

const args = process.argv.slice(2);
const cmd = args[0];

function flag(name: string, fallback?: string): string | undefined {
	const i = args.indexOf(`--${name}`);
	return i >= 0 && args[i + 1] ? args[i + 1] : fallback;
}

function help(): void {
	console.log(`Usage:
  traces list [--limit N] [--channel computer]
  traces show <id>
  traces replay <id>
  traces purge --older-than 30d`);
}

if (!cmd || cmd === "--help" || cmd === "-h") {
	help();
	process.exit(0);
}

const store = new ComputerUseTraceStore(defaultTraceDbPath());

try {
	if (cmd === "list") {
		const limit = Number(flag("limit", "20"));
		const channel = flag("channel");
		const rows = store.listRecent(limit, channel);
		if (rows.length === 0) {
			console.log("(no traces)");
		} else {
			for (const r of rows) {
				const ended = r.endedAt ? new Date(r.endedAt).toISOString() : "(open)";
				const outcome = r.outcome ?? "-";
				console.log(
					`${r.id}  ${r.channel.padEnd(8)}  ${outcome.padEnd(8)}  steps=${String(r.stepCount).padStart(3)}  ` +
						`started=${new Date(r.startedAt).toISOString()}  ended=${ended}`,
				);
				console.log(`  intent: ${truncate(r.intent, 120)}`);
				if (r.summary) console.log(`  summary: ${truncate(r.summary, 120)}`);
			}
		}
	} else if (cmd === "show") {
		const id = args[1];
		if (!id) {
			console.error("usage: traces show <id>");
			process.exit(2);
		}
		const t = store.getTrace(id);
		if (!t) {
			console.error(`trace ${id} not found`);
			process.exit(1);
		}
		console.log(`Trace ${t.id}`);
		console.log(`  session: ${t.sessionId}`);
		console.log(`  channel: ${t.channel}`);
		console.log(`  intent:  ${t.intent}`);
		console.log(`  started: ${new Date(t.startedAt).toISOString()}`);
		console.log(
			`  ended:   ${t.endedAt ? new Date(t.endedAt).toISOString() : "(open)"}`,
		);
		console.log(`  outcome: ${t.outcome ?? "-"}`);
		console.log(`  summary: ${t.summary ?? "-"}`);
		console.log(`  steps:   ${t.stepCount}`);
		console.log("");
		for (const s of t.steps) {
			console.log(
				`  [${s.stepIndex}] ${s.perceptionKind} ${s.toolCallName ?? "(no tool)"}  ${s.ms}ms  tokens=${s.tokensUsed}`,
			);
			if (s.screenshotPath)
				console.log(`      screenshot: ${s.screenshotPath}`);
			if (s.toolCallArgs !== null)
				console.log(
					`      args: ${truncate(JSON.stringify(s.toolCallArgs), 200)}`,
				);
			if (s.toolResult !== null)
				console.log(
					`      result: ${truncate(JSON.stringify(s.toolResult), 200)}`,
				);
		}
	} else if (cmd === "replay") {
		const id = args[1];
		if (!id) {
			console.error("usage: traces replay <id>");
			process.exit(2);
		}
		const t = store.getTrace(id);
		if (!t) {
			console.error(`trace ${id} not found`);
			process.exit(1);
		}
		emit({
			type: "trace.start",
			protocolVersion: 1,
			traceId: t.id,
			sessionId: t.sessionId,
			channel: t.channel,
			intent: t.intent,
			startedAt: t.startedAt,
		});
		for (const s of t.steps)
			emit({ type: "trace.step", protocolVersion: 1, ...stepEvent(t.id, s) });
		emit({
			type: "trace.end",
			protocolVersion: 1,
			traceId: t.id,
			outcome: t.outcome,
			summary: t.summary,
			endedAt: t.endedAt,
		});
	} else if (cmd === "purge") {
		const spec = flag("older-than");
		if (!spec) {
			console.error("usage: traces purge --older-than 30d");
			process.exit(2);
		}
		const ms = parseDuration(spec);
		if (ms == null) {
			console.error(`unrecognised duration: ${spec}`);
			process.exit(2);
		}
		const cutoff = Date.now() - ms;
		const res = store.purgeOlderThan(cutoff);
		console.log(
			`purged ${res.traces} trace(s), ${res.files} screenshot file(s)`,
		);
	} else {
		help();
		process.exit(2);
	}
} finally {
	store.close();
}

function truncate(s: string, n: number): string {
	if (s.length <= n) return s;
	return `${s.slice(0, n - 1)}…`;
}

function emit(obj: unknown): void {
	process.stdout.write(`${JSON.stringify(obj)}\n`);
}

function stepEvent(traceId: string, s: TraceStepRow) {
	return {
		traceId,
		stepIndex: s.stepIndex,
		perceptionKind: s.perceptionKind,
		screenshotPath: s.screenshotPath,
		toolCallName: s.toolCallName,
		toolCallArgs: s.toolCallArgs,
		toolResult: s.toolResult,
		tokensUsed: s.tokensUsed,
		ms: s.ms,
		at: s.createdAt,
	};
}

function parseDuration(spec: string): number | null {
	const m = spec.match(/^(\d+)\s*(ms|s|m|h|d|w)$/);
	if (!m) return null;
	const n = Number(m[1]);
	const unit = m[2];
	const mult: Record<string, number> = {
		ms: 1,
		s: 1000,
		m: 60_000,
		h: 3_600_000,
		d: 86_400_000,
		w: 604_800_000,
	};
	return n * mult[unit];
}
