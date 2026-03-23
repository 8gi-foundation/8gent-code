#!/usr/bin/env bun
/**
 * Model Shootout - Test different free models on the same task via the Vessel.
 *
 * Sends the same well-scoped task to different models and compares results.
 * Uses the Vessel daemon, cycling DEFAULT_MODEL between tests via fly secrets.
 */

const VESSEL_URL = "wss://eight-vessel.fly.dev";
const VESSEL_HEALTH = "https://eight-vessel.fly.dev/health";
const TIMEOUT_MS = 180_000; // 3 minutes per model

// Models to test - one task each for efficiency
const MODELS_AND_TASKS: Array<{
  model: string;
  shortName: string;
  task: string;
  issueRef: string;
}> = [
  {
    model: "qwen/qwen3-coder:free",
    shortName: "Qwen3-Coder",
    issueRef: "#9 checkpoints",
    task: `Create a file at packages/memory/checkpoint-test.ts with this exact content:

/**
 * Memory Checkpoint Test - validates checkpoint/rollback works.
 */
import { Database } from "bun:sqlite";
import { mkdirSync, existsSync } from "fs";

export function testCheckpoint(): { passed: boolean; detail: string } {
  const tmpDir = "/tmp/8gent-checkpoint-test-" + Date.now();
  mkdirSync(tmpDir, { recursive: true });
  const dbPath = tmpDir + "/test.db";
  const db = new Database(dbPath, { create: true });
  db.exec("CREATE TABLE t (id INTEGER PRIMARY KEY, val TEXT)");
  db.exec("INSERT INTO t VALUES (1, 'before')");

  // Checkpoint
  const cpPath = tmpDir + "/checkpoint.db";
  db.exec("VACUUM INTO '" + cpPath + "'");

  // Mutate
  db.exec("UPDATE t SET val = 'after' WHERE id = 1");

  // Verify checkpoint has original
  const cpDb = new Database(cpPath);
  const row = cpDb.prepare("SELECT val FROM t WHERE id = 1").get() as any;
  cpDb.close();
  db.close();

  if (row?.val === "before") {
    return { passed: true, detail: "Checkpoint preserved original state" };
  }
  return { passed: false, detail: "Expected 'before', got: " + row?.val };
}

Then run: bun -e "import { testCheckpoint } from './packages/memory/checkpoint-test.ts'; console.log(JSON.stringify(testCheckpoint()))"

Report the test result.`,
  },
  {
    model: "nvidia/nemotron-3-nano-30b-a3b:free",
    shortName: "Nemotron-Nano-30B",
    issueRef: "#8 health",
    task: `Read the file packages/memory/health.ts and tell me:
1. What interface does it export?
2. What SQL queries does it run?
3. Is there any bug in the health score calculation?

Then create a file packages/memory/health-test.ts that imports memoryHealth and tests it with a fresh in-memory SQLite database. The test should:
1. Create the memories table (id TEXT, content_text TEXT, importance REAL, created_at INTEGER, deleted_at INTEGER)
2. Insert 3 test memories
3. Call memoryHealth(db)
4. Assert totalCount === 3
5. Print the result as JSON`,
  },
  {
    model: "qwen/qwen3-next-80b-a3b-instruct:free",
    shortName: "Qwen3-Next-80B",
    issueRef: "#7 contradictions",
    task: `Read packages/memory/contradictions.ts and analyze it:
1. What detection algorithm does it use?
2. Are there any edge cases that would produce false positives?
3. Write a test: create packages/memory/contradictions-test.ts that:
   - Imports detectContradictions
   - Creates an in-memory SQLite db with the memories table
   - Inserts two contradicting memories: "The sky is blue" and "The sky is not blue"
   - Inserts two non-contradicting memories: "Dogs are pets" and "Cats are pets"
   - Runs detectContradictions and verifies it finds exactly 1 contradiction
   - Prints pass/fail`,
  },
  {
    model: "google/gemma-3-27b-it:free",
    shortName: "Gemma-3-27B",
    issueRef: "code review",
    task: `Read packages/permissions/index.ts and find the isHeadless() and isPushToMain() methods.
Answer these questions:
1. Is the isPushToMain regex correct? Could "git push origin feat/fix-main-page" incorrectly match?
2. Is isHeadless() reliable? What about SSH sessions where stdin.isTTY might be true?
3. Suggest one concrete improvement to each method.

Keep your response under 500 characters.`,
  },
  {
    model: "openai/gpt-oss-120b:free",
    shortName: "GPT-OSS-120B",
    issueRef: "#17 pragma",
    task: `Read packages/memory/store.ts lines 180-195. The PRAGMA statements were recently changed from db.pragma() to db.exec().
1. Is this change correct for bun:sqlite compatibility?
2. Is the try/catch sufficient or should each PRAGMA be individual?
3. Does WAL mode work with bun:sqlite?
Answer concisely in under 300 characters.`,
  },
];

interface ModelResult {
  model: string;
  shortName: string;
  issueRef: string;
  status: "success" | "error" | "timeout";
  response: string;
  toolCalls: number;
  durationMs: number;
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
    stdout: "pipe",
    stderr: "pipe",
  });
  await proc.exited;
  // Wait for restart
  console.log(`  Waiting for vessel to restart...`);
  const up = await waitForVessel();
  if (!up) throw new Error("Vessel failed to restart");
  // Extra settling time
  await new Promise((r) => setTimeout(r, 5_000));
  console.log(`  Vessel ready with ${model}`);
}

async function runTask(task: string): Promise<ModelResult & { rawResponse: string }> {
  const ws = new WebSocket(VESSEL_URL);
  await new Promise<void>((resolve, reject) => {
    ws.onopen = () => resolve();
    ws.onerror = () => reject(new Error("WS connect failed"));
    setTimeout(() => reject(new Error("WS timeout")), 10_000);
  });

  // Create session
  const sessionPromise = new Promise<string>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("session timeout")), 15_000);
    const handler = (event: MessageEvent) => {
      const msg = JSON.parse(event.data as string);
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

  // Send prompt
  ws.send(JSON.stringify({ type: "prompt", text: task }));
  const startMs = Date.now();
  let toolCalls = 0;
  let response = "";
  let chunks: string[] = [];

  return new Promise((resolve) => {
    const deadline = setTimeout(() => {
      ws.send(JSON.stringify({ type: "session:destroy", sessionId }));
      ws.close();
      resolve({
        model: "", shortName: "", issueRef: "",
        status: "timeout",
        response: chunks.join("") || "[timeout, no response]",
        rawResponse: chunks.join(""),
        toolCalls,
        durationMs: Date.now() - startMs,
      });
    }, TIMEOUT_MS);

    ws.addEventListener("message", (event: MessageEvent) => {
      const msg = JSON.parse(event.data as string);
      if (msg.type !== "event") return;
      const { event: evt, payload } = msg;

      if (evt === "tool:start") {
        toolCalls++;
        console.log(`    [tool] ${payload.tool}(${JSON.stringify(payload.input || {}).slice(0, 60)})`);
      } else if (evt === "agent:stream") {
        if (payload.chunk) chunks.push(payload.chunk);
        if (payload.final) {
          clearTimeout(deadline);
          response = payload.chunk || chunks.join("");
          ws.send(JSON.stringify({ type: "session:destroy", sessionId }));
          ws.close();
          resolve({
            model: "", shortName: "", issueRef: "",
            status: "success",
            response,
            rawResponse: chunks.join(""),
            toolCalls,
            durationMs: Date.now() - startMs,
          });
        }
      } else if (evt === "agent:error") {
        clearTimeout(deadline);
        ws.send(JSON.stringify({ type: "session:destroy", sessionId }));
        ws.close();
        resolve({
          model: "", shortName: "", issueRef: "",
          status: "error",
          response: payload.error,
          rawResponse: payload.error,
          toolCalls,
          durationMs: Date.now() - startMs,
        });
      }
    });
  });
}

async function main() {
  console.log("MODEL SHOOTOUT");
  console.log("=".repeat(70));
  console.log(`Testing ${MODELS_AND_TASKS.length} models, one task each`);
  console.log("=".repeat(70));

  const results: ModelResult[] = [];

  for (const entry of MODELS_AND_TASKS) {
    console.log(`\n${"─".repeat(70)}`);
    console.log(`${entry.shortName} (${entry.model})`);
    console.log(`Task: ${entry.issueRef}`);
    console.log(`${"─".repeat(70)}`);

    try {
      await setModel(entry.model);
      const result = await runTask(entry.task);
      result.model = entry.model;
      result.shortName = entry.shortName;
      result.issueRef = entry.issueRef;
      results.push(result);

      const icon = result.status === "success" ? "PASS" : result.status === "timeout" ? "TIME" : "FAIL";
      console.log(`\n  [${icon}] ${result.toolCalls} tools, ${Math.round(result.durationMs / 1000)}s`);
      console.log(`  Response preview: ${result.response.slice(0, 200)}`);
    } catch (err) {
      console.error(`  SETUP ERROR: ${err}`);
      results.push({
        model: entry.model,
        shortName: entry.shortName,
        issueRef: entry.issueRef,
        status: "error",
        response: String(err),
        toolCalls: 0,
        durationMs: 0,
      });
    }
  }

  // Scoreboard
  console.log("\n\n" + "=".repeat(70));
  console.log("SCOREBOARD");
  console.log("=".repeat(70));
  console.log(`${"Model".padEnd(25)} ${"Task".padEnd(20)} ${"Status".padEnd(8)} ${"Tools".padEnd(6)} ${"Time".padEnd(8)}`);
  console.log("─".repeat(70));

  for (const r of results) {
    const icon = r.status === "success" ? "PASS" : r.status === "timeout" ? "TIME" : "FAIL";
    console.log(`${r.shortName.padEnd(25)} ${r.issueRef.padEnd(20)} ${icon.padEnd(8)} ${String(r.toolCalls).padEnd(6)} ${Math.round(r.durationMs / 1000)}s`);
  }

  console.log("=".repeat(70));

  // Write full results
  await Bun.write("/tmp/model-shootout.json", JSON.stringify(results, null, 2));
  console.log("\nFull results: /tmp/model-shootout.json");

  // Restore default model
  console.log("\nRestoring auto:free default...");
  await setModel("auto:free");
}

main().catch(console.error);
