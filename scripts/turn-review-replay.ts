/**
 * Replay recorded pilot runs through the turn-end side reviewer (#3419).
 * Read-only: it reads each run's result.json, launch.json and session log
 * and prints what the reviewer would have said. It runs no agent and writes
 * nothing.
 *
 * The ledger is rebuilt as agent.ts records it: each tool result cut to 500
 * characters, and an error-string result counted as a failure. The reply is
 * the turn's last assistant text.
 *
 *   bun scripts/turn-review-replay.ts <run-dir>...
 *   # a run dir holds result.json, launch.json and home/.8gent/sessions/session_<n>_*.jsonl
 */
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { isErrorToolResult } from "../packages/eight/honesty";
import { type TurnReviewToolCall, reviewTurn } from "../packages/verify/turn-review";

type Turn = { prompt: string; calls: TurnReviewToolCall[]; reply: string };

function readTurns(sessionFile: string): Turn[] {
	const turns: Turn[] = [];
	const byId = new Map<string, TurnReviewToolCall>();
	for (const line of readFileSync(sessionFile, "utf-8").trim().split("\n")) {
		const e = JSON.parse(line);
		if (e.type === "user_message")
			turns.push({ prompt: String(e.message.content), calls: [], reply: "" });
		const t = turns[turns.length - 1];
		if (!t) continue;
		if (e.type === "tool_call") {
			const c: TurnReviewToolCall = {
				name: e.toolCall.name,
				args: e.toolCall.arguments,
				success: true,
			};
			byId.set(e.toolCall.toolCallId, c);
			t.calls.push(c);
		} else if (e.type === "tool_result" || e.type === "tool_error") {
			const c = byId.get(e.toolCallId);
			if (!c) continue;
			const raw = String(e.type === "tool_error" ? e.error : (e.result ?? ""));
			c.result = raw.slice(0, 500);
			c.success = e.type === "tool_result" && e.success !== false && !isErrorToolResult(raw);
		} else if (e.type === "assistant_content") {
			const text = (e.parts ?? [])
				.filter((p: { type: string }) => p.type === "text")
				.map((p: { text: string }) => p.text)
				.join("");
			if (text.trim()) t.reply = text;
		}
	}
	return turns;
}

for (const dir of process.argv.slice(2)) {
	const result = JSON.parse(readFileSync(join(dir, "result.json"), "utf-8"));
	const cwd = JSON.parse(readFileSync(join(dir, "launch.json"), "utf-8")).cwd;
	const sessions = join(dir, "home", ".8gent", "sessions");
	const file = readdirSync(sessions).find((f) => /^session_\d+_/.test(f));
	console.log(`\n=== ${dir}  pass=${result.pass} (${result.checksPass})`);
	if (!file) {
		console.log("  no session log");
		continue;
	}
	for (const c of result.checks ?? []) {
		if (!c.pass) console.log(`  actual FAIL: ${c.name} | ${String(c.detail).slice(0, 140)}`);
	}
	const turns = readTurns(join(sessions, file));
	if (turns.length === 0) console.log("  no user turn in the log");
	turns.forEach((t, i) => {
		const lines = reviewTurn({
			prompt: t.prompt,
			toolCalls: t.calls,
			reply: t.reply,
			workingDirectory: cwd,
		});
		console.log(`  turn ${i}: ${t.calls.length} tool calls`);
		if (lines.length === 0) console.log("  reviewer: (silent)");
		for (const l of lines) console.log(`  [turn-review] ${l}`);
	});
}
