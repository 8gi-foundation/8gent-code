#!/usr/bin/env bun
/** Headless smoke test for the trace capture pipeline. */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { ComputerUseTraceStore } from "../computer-use-traces.js";

const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "8gent-trace-smoke-"));
const dbPath = path.join(tmpRoot, "traces.db");
const tracesDir = path.join(tmpRoot, "traces");

const store = new ComputerUseTraceStore(dbPath, { tracesDir });

const sessionId = `smoke-session-${Date.now()}`;
const traceId = store.startTrace({
	sessionId,
	channel: "computer",
	intent: "Open Calculator and type 2+2",
	originatingChannel: "telegram",
	dispatchSource: "telegram-bot:smoke-test-user",
	dispatchId: `disp-${Date.now()}`,
});

const sessionDir = path.join(tracesDir, sessionId);
const shotPath = path.join(sessionDir, "0.png");
fs.writeFileSync(shotPath, Buffer.from([0x89, 0x50, 0x4e, 0x47]));

store.appendStep(traceId, {
	perceptionKind: "screenshot",
	screenshotPath: shotPath,
	toolCallName: "screenshot",
	toolCallArgs: { region: "full" },
	toolResult: { ok: true, path: shotPath },
	tokensUsed: 12,
	ms: 84,
});
store.appendStep(traceId, {
	perceptionKind: "tree",
	toolCallName: "click",
	toolCallArgs: { x: 120, y: 240 },
	toolResult: { ok: true },
	tokensUsed: 7,
	ms: 33,
});

store.closeTrace(traceId, {
	outcome: "ok",
	summary: "calculator opened, 2+2 typed",
});

const full = store.getTrace(traceId);
const errors: string[] = [];
if (!full) errors.push("getTrace returned null");
if (full && full.outcome !== "ok") errors.push("outcome != ok");
if (full && full.stepCount !== 2)
	errors.push(`stepCount != 2 (got ${full.stepCount})`);
if (full && full.steps.length !== 2) errors.push("steps.length != 2");
if (full && full.steps[0].screenshotPath !== shotPath)
	errors.push("screenshot path lost");
if (full && full.steps[0].stepIndex !== 0) errors.push("step 0 index wrong");
if (full && full.steps[1].stepIndex !== 1) errors.push("step 1 index wrong");
if (!fs.existsSync(shotPath)) errors.push("screenshot file missing on disk");

const recent = store.listRecent(5, "computer");
if (!recent.find((t) => t.id === traceId))
	errors.push("listRecent did not surface trace");

const filteredOut = store.listRecent(5, "telegram");
if (filteredOut.find((t) => t.id === traceId))
	errors.push("channel filter leaked trace");

if (full?.originatingChannel !== "telegram")
	errors.push("originatingChannel not persisted");
if (full?.dispatchSource !== "telegram-bot:smoke-test-user")
	errors.push("dispatchSource not persisted");
if (!full?.dispatchId) errors.push("dispatchId not persisted");

console.log("trace id:", traceId);
console.log("steps captured:", full?.steps.length ?? 0);
console.log("listRecent[computer] count:", recent.length);
console.log("screenshot on disk:", fs.existsSync(shotPath));
console.log(
	"first tool:",
	full?.steps[0].toolCallName,
	full?.steps[0].toolCallArgs,
);
console.log(
	"second tool:",
	full?.steps[1].toolCallName,
	full?.steps[1].toolCallArgs,
);
console.log("outcome:", full?.outcome, "summary:", full?.summary);

store.close();
fs.rmSync(tmpRoot, { recursive: true, force: true });

if (errors.length > 0) {
	console.error("SMOKE FAIL:", errors.join("; "));
	process.exit(1);
}
console.log("SMOKE OK");
