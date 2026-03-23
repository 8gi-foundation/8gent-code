#!/usr/bin/env bun
/**
 * Model Shootout v2 - Test models with tool use support, avoid rate-limited ones.
 * Uses less popular models that are more likely to have capacity.
 */

const VESSEL_URL = "wss://eight-vessel.fly.dev";
const VESSEL_HEALTH = "https://eight-vessel.fly.dev/health";
const TIMEOUT_MS = 180_000;

// The same task for all models - a concrete, well-scoped coding task
const STANDARD_TASK = `Create a file at packages/memory/shootout-test.ts with this content:

import { Database } from "bun:sqlite";

const db = new Database(":memory:");
db.exec("CREATE TABLE memories (id TEXT PRIMARY KEY, content_text TEXT, importance REAL, created_at INTEGER, deleted_at INTEGER)");
db.exec("INSERT INTO memories VALUES ('m1', 'The sky is blue', 0.8, 1000, NULL)");
db.exec("INSERT INTO memories VALUES ('m2', 'Dogs are loyal', 0.6, 2000, NULL)");
db.exec("INSERT INTO memories VALUES ('m3', 'Old stale memory', 0.1, 500, NULL)");

const total = (db.prepare("SELECT COUNT(*) as c FROM memories WHERE deleted_at IS NULL").get() as any).c;
const stale = (db.prepare("SELECT COUNT(*) as c FROM memories WHERE deleted_at IS NULL AND importance < 0.3").get() as any).c;

console.log(JSON.stringify({ total, stale, passed: total === 3 && stale === 1 }));
db.close();

Then run it with: bun packages/memory/shootout-test.ts
Report what it outputs.`;

const MODELS = [
  "nvidia/nemotron-3-super-120b-a12b:free",
  "nvidia/nemotron-3-nano-30b-a3b:free",
  "stepfun/step-3.5-flash:free",
  "mistralai/mistral-small-3.1-24b-instruct:free",
  "meta-llama/llama-3.3-70b-instruct:free",
];

interface Result {
  model: string;
  status: "success" | "error" | "timeout";
  response: string;
  toolCalls: number;
  durationMs: number;
  wroteFile: boolean;
  ranTest: boolean;
  testPassed: boolean;
}

async function waitForVessel(maxWait = 60_000): Promise<boolean> {
  const start = Date.now();
  while (Date.now() - start < maxWait) {
    try {
      const res = await fetch(VESSEL_HEALTH);
      if (res.ok) return true;
    } catch {}
    await new Promise((r) => setTimeout(r, 3_000));
  }
  return false;
}

async function setModel(model: string): Promise<void> {
  console.log(`  Setting model to ${model}...`);
  const proc = Bun.spawn(["fly", "secrets", "set", `DEFAULT_MODEL=${model}`, "--app", "eight-vessel"], {
    stdout: "pipe", stderr: "pipe",
  });
  await proc.exited;
  console.log(`  Waiting for vessel restart...`);
  await waitForVessel();
  await new Promise((r) => setTimeout(r, 5_000));
}

async function runTask(model: string): Promise<Result> {
  const ws = new WebSocket(VESSEL_URL);
  await new Promise<void>((resolve, reject) => {
    ws.onopen = () => resolve();
    ws.onerror = () => reject(new Error("WS failed"));
    setTimeout(() => reject(new Error("WS timeout")), 10_000);
  });

  // Create session
  const sessionPromise = new Promise<string>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("session timeout")), 15_000);
    const handler = (e: MessageEvent) => {
      const msg = JSON.parse(e.data as string);
      if (msg.type === "session:created") {
        clearTimeout(timer);
        ws.removeEventListener("message", handler);
        resolve(msg.sessionId);
      }
    };
    ws.addEventListener("message", handler);
  });
  ws.send(JSON.stringify({ type: "session:create", channel: "delegation" }));
  const sessionId = await sessionPromise;
  await new Promise((r) => setTimeout(r, 3_000));

  ws.send(JSON.stringify({ type: "prompt", text: STANDARD_TASK }));
  const startMs = Date.now();
  let toolCalls = 0;
  let wroteFile = false;
  let ranTest = false;
  let testPassed = false;
  let chunks: string[] = [];

  return new Promise((resolve) => {
    const deadline = setTimeout(() => {
      ws.send(JSON.stringify({ type: "session:destroy", sessionId }));
      ws.close();
      resolve({ model, status: "timeout", response: chunks.join("").slice(0, 500), toolCalls, durationMs: Date.now() - startMs, wroteFile, ranTest, testPassed });
    }, TIMEOUT_MS);

    ws.addEventListener("message", (e: MessageEvent) => {
      const msg = JSON.parse(e.data as string);
      if (msg.type !== "event") return;
      const { event: evt, payload } = msg;

      if (evt === "tool:start") {
        toolCalls++;
        const tool = payload.tool;
        const input = JSON.stringify(payload.input || {}).slice(0, 80);
        console.log(`    [${tool}] ${input}`);
        if (tool === "write_file") wroteFile = true;
        if (tool === "run_command" && input.includes("shootout-test")) ranTest = true;
      } else if (evt === "tool:result") {
        const output = (payload.output || "").slice(0, 200);
        if (output.includes('"passed":true') || output.includes('"passed": true')) testPassed = true;
        console.log(`    => ${output.slice(0, 100)}`);
      } else if (evt === "agent:stream") {
        if (payload.chunk) chunks.push(payload.chunk);
        if (payload.final) {
          clearTimeout(deadline);
          ws.send(JSON.stringify({ type: "session:destroy", sessionId }));
          ws.close();
          resolve({ model, status: "success", response: (payload.chunk || chunks.join("")).slice(0, 500), toolCalls, durationMs: Date.now() - startMs, wroteFile, ranTest, testPassed });
        }
      } else if (evt === "agent:error") {
        clearTimeout(deadline);
        ws.send(JSON.stringify({ type: "session:destroy", sessionId }));
        ws.close();
        resolve({ model, status: "error", response: payload.error, toolCalls, durationMs: Date.now() - startMs, wroteFile, ranTest, testPassed });
      }
    });
  });
}

async function main() {
  console.log("MODEL SHOOTOUT v2 - Same Task, Different Models");
  console.log("Task: Create test file + run it + report result");
  console.log("=".repeat(70));

  const results: Result[] = [];

  for (const model of MODELS) {
    const shortName = model.split("/")[1].split(":")[0];
    console.log(`\n${"─".repeat(70)}`);
    console.log(`${shortName}`);
    console.log(`${"─".repeat(70)}`);

    try {
      await setModel(model);
      const result = await runTask(model);
      results.push(result);
    } catch (err) {
      console.error(`  ERROR: ${err}`);
      results.push({ model, status: "error", response: String(err), toolCalls: 0, durationMs: 0, wroteFile: false, ranTest: false, testPassed: false });
    }

    // Clean up the test file for next model
    try {
      const proc = Bun.spawn(["fly", "ssh", "console", "--app", "eight-vessel", "-C", "bash -c 'rm -f /app/packages/memory/shootout-test.ts'"], { stdout: "pipe", stderr: "pipe" });
      await proc.exited;
    } catch {}
  }

  // Scoreboard
  console.log("\n\n" + "=".repeat(70));
  console.log("SCOREBOARD - Same task across 5 models");
  console.log("=".repeat(70));
  console.log(`${"Model".padEnd(35)} ${"Status".padEnd(8)} ${"Wrote".padEnd(6)} ${"Ran".padEnd(5)} ${"Pass".padEnd(6)} ${"Tools".padEnd(6)} ${"Time"}`);
  console.log("─".repeat(70));

  for (const r of results) {
    const name = r.model.split("/")[1].split(":")[0];
    const icon = r.status === "success" ? "OK" : r.status === "timeout" ? "TIME" : "FAIL";
    console.log(`${name.padEnd(35)} ${icon.padEnd(8)} ${(r.wroteFile ? "Y" : "N").padEnd(6)} ${(r.ranTest ? "Y" : "N").padEnd(5)} ${(r.testPassed ? "Y" : "N").padEnd(6)} ${String(r.toolCalls).padEnd(6)} ${Math.round(r.durationMs / 1000)}s`);
  }

  const winners = results.filter(r => r.testPassed);
  console.log(`\n${winners.length}/${results.length} models completed the full task (write + run + pass)`);
  if (winners.length > 0) {
    const fastest = winners.sort((a, b) => a.durationMs - b.durationMs)[0];
    console.log(`Fastest winner: ${fastest.model.split("/")[1]} in ${Math.round(fastest.durationMs / 1000)}s`);
  }
  console.log("=".repeat(70));

  await Bun.write("/tmp/model-shootout-v2.json", JSON.stringify(results, null, 2));

  // Restore default
  console.log("\nRestoring auto:free...");
  await setModel("auto:free");
}

main().catch(console.error);
