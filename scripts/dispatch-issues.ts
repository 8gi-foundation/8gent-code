#!/usr/bin/env bun
/**
 * Issue Dispatcher - Orchestrates work across local and vessel 8gent instances.
 *
 * Sends GitHub issue work to 8gent agents via daemon WebSocket protocol.
 * Local agent: eight-1-q-14b (Qwen 3 14B fine-tuned)
 * Vessel agent: Nemotron 120B (free via OpenRouter)
 */

const LOCAL_URL = "ws://localhost:18789";
const VESSEL_URL = "wss://eight-vessel.fly.dev";
const TIMEOUT_MS = 180_000; // 3 minutes per task

interface TaskAssignment {
  issueNumber: number;
  title: string;
  prompt: string;
  target: "local" | "vessel";
}

interface TaskResult {
  issueNumber: number;
  target: string;
  status: "success" | "error" | "timeout";
  response: string;
  durationMs: number;
  toolCalls: number;
}

const assignments: TaskAssignment[] = [
  // --- Local Eight (14B) - focused, smaller tasks ---
  {
    issueNumber: 17,
    title: "Fix bun:sqlite .pragma() crash",
    target: "local",
    prompt: `You are working on GitHub issue #17 for the 8gent-code project.

TASK: Fix bun:sqlite .pragma() crash in the Vessel container.

PROBLEM: MemoryStore init crashes with 'this.db.pragma is not a function' in Bun runtime.

FIX NEEDED: In packages/memory/store.ts, find any usage of this.db.pragma() and replace with this.db.exec('PRAGMA ...') syntax which is compatible with both better-sqlite3 and bun:sqlite.

Also wrap the pragma calls in a try/catch so memory gracefully degrades if SQLite has issues.

CONSTRAINTS:
- Only modify packages/memory/store.ts
- Keep changes minimal
- Use db.exec() for PRAGMA statements instead of db.pragma()
- Add try/catch around SQLite initialization

Create the fix on a branch called fix/bun-sqlite-pragma and commit your changes.`,
  },
  {
    issueNumber: 9,
    title: "Memory checkpointing and rollback",
    target: "local",
    prompt: `You are working on GitHub issue #9 for the 8gent-code project.

TASK: Add memory checkpointing before consolidation runs.

IMPLEMENTATION:
1. In packages/memory/, create a new file called checkpoint.ts
2. Export a function: checkpoint(db: Database, dataDir: string): string
   - Uses SQLite VACUUM INTO to create a timestamped snapshot
   - Returns the checkpoint file path
   - Path format: {dataDir}/memory-checkpoints/memory-{ISO-timestamp}.db
3. Export a function: rollback(db: Database, checkpointPath: string): void
   - Copies checkpoint back over the main database
4. Export a function: listCheckpoints(dataDir: string): string[]
   - Lists available checkpoint files sorted by date

CONSTRAINTS:
- ~30 lines of code
- Use Bun.file() for file operations
- Create the checkpoints directory if it doesn't exist
- Only keep last 5 checkpoints (delete oldest)

Create the fix on a branch called feat/memory-checkpoints and commit your changes.`,
  },
  {
    issueNumber: 8,
    title: "Memory health introspection",
    target: "local",
    prompt: `You are working on GitHub issue #8 for the 8gent-code project.

TASK: Add a memoryHealth() function to packages/memory/.

IMPLEMENTATION:
1. Create packages/memory/health.ts
2. Export function: memoryHealth(db: Database): MemoryHealth
3. MemoryHealth interface:
   {
     totalCount: number;       // Total memories
     staleCount: number;       // Memories with strength < 0.3
     avgStrength: number;      // Average memory strength
     oldestMemory: string;     // ISO date of oldest memory
     newestMemory: string;     // ISO date of newest memory
     lastConsolidation: string | null; // ISO date
     healthScore: number;      // 0-100 composite score
   }
4. Health score formula:
   - Start at 100
   - Subtract (staleCount / totalCount) * 30
   - Subtract 20 if no consolidation in last 7 days
   - Subtract 10 if totalCount > 1000 (bloat penalty)
   - Clamp to 0-100
5. Wire it into packages/memory/index.ts exports

CONSTRAINTS:
- ~50 lines
- Pure SQL queries, no external dependencies
- Use db.prepare().get() for aggregate queries

Create on branch feat/memory-health and commit.`,
  },

  // --- Vessel Eight (Nemotron 120B) - harder reasoning tasks ---
  {
    issueNumber: 7,
    title: "Memory contradiction detection",
    target: "vessel",
    prompt: `You are working on GitHub issue #7 for the 8gent-code project.

TASK: Add contradiction detection to the memory consolidation pipeline.

IMPLEMENTATION:
1. Create packages/memory/contradictions.ts
2. Export function: detectContradictions(db: Database): Contradiction[]
3. Contradiction interface:
   {
     memoryA: { id: string; content: string; createdAt: string };
     memoryB: { id: string; content: string; createdAt: string };
     conflictType: "value" | "temporal" | "negation";
     confidence: number; // 0-1
   }
4. Detection algorithm (deterministic, no LLM needed):
   - Query all active memories (strength > 0.3)
   - Group by entity (extract first noun phrase or subject)
   - Within each group, compare pairs:
     a. "negation": one contains "not" or "never" + same predicate
     b. "value": same property, different value (e.g. "color is red" vs "color is blue")
     c. "temporal": conflicting time references for same event
   - Use simple keyword matching, not regex
5. Export function: resolveContradiction(contradiction: Contradiction): string
   - Returns the ID of the memory to keep (newer wins by default)

CONSTRAINTS:
- ~60 lines
- No LLM calls - purely deterministic
- Use simple string matching
- Export from packages/memory/index.ts

The repo is cloned at /app/. Work there.
Create on branch feat/memory-contradictions and commit.`,
  },
  {
    issueNumber: 21,
    title: "Headless permissions fix",
    target: "vessel",
    prompt: `You are working on GitHub issue #21 for the 8gent-code project.

TASK: Fix the headless permission mode being too restrictive.

PROBLEM: The security patch made headless mode only allow read-only commands. But the Vessel needs to write files, commit, and push to feature branches for /delegate to work.

FIX: In packages/permissions/index.ts, update the headless mode logic:

1. Find the HEADLESS_SAFE_COMMANDS list and the isHeadless auto-approve logic
2. Add these to the safe list:
   - write operations: mkdir, touch, cp (not rm -rf)
   - git operations: git add, git commit, git checkout -b, git branch, git push (but NOT git push to main/master)
   - bun operations: bun install, bun run, bun test
3. Add a new check: isGitPushToMain(command) that returns true if the command pushes to main or master
4. In auto-approve: allow everything in the expanded safe list EXCEPT git push to main

CONSTRAINTS:
- Only modify packages/permissions/index.ts
- Keep the always-blocked list (rm -rf /, etc.) unchanged
- Be conservative - only add what's needed for delegation to work

The repo is at /app/. Create on branch fix/headless-permissions and commit.`,
  },
];

async function connectDaemon(url: string): Promise<WebSocket> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url);
    const timer = setTimeout(() => reject(new Error(`Connection timeout: ${url}`)), 10_000);
    ws.onopen = () => { clearTimeout(timer); resolve(ws); };
    ws.onerror = (err) => { clearTimeout(timer); reject(new Error(`Connection failed: ${url}`)); };
  });
}

function sendAndWait(ws: WebSocket, msg: any, type: string, timeoutMs = 30_000): Promise<any> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`Timeout waiting for ${type}`)), timeoutMs);
    const handler = (event: MessageEvent) => {
      const data = JSON.parse(typeof event.data === "string" ? event.data : "{}");
      if (data.type === type) {
        clearTimeout(timer);
        ws.removeEventListener("message", handler);
        resolve(data);
      }
    };
    ws.addEventListener("message", handler);
    ws.send(JSON.stringify(msg));
  });
}

async function executeTask(ws: WebSocket, task: TaskAssignment): Promise<TaskResult> {
  const startMs = Date.now();
  let toolCalls = 0;
  let response = "";

  console.log(`\n${"=".repeat(70)}`);
  console.log(`[${task.target.toUpperCase()}] Starting issue #${task.issueNumber}: ${task.title}`);
  console.log(`${"=".repeat(70)}`);

  // Create session
  const sessionReply = await sendAndWait(ws, { type: "session:create", channel: "delegation" }, "session:created", 15_000);
  const sessionId = sessionReply.sessionId;
  console.log(`  Session created: ${sessionId}`);

  // Wait for agent init
  await new Promise((r) => setTimeout(r, 3_000));

  // Send prompt
  ws.send(JSON.stringify({ type: "prompt", text: task.prompt }));
  console.log(`  Prompt sent (${task.prompt.length} chars)`);

  // Collect events
  return new Promise((resolve) => {
    const deadline = setTimeout(() => {
      console.log(`  TIMEOUT after ${TIMEOUT_MS / 1000}s`);
      ws.send(JSON.stringify({ type: "session:destroy", sessionId }));
      resolve({
        issueNumber: task.issueNumber,
        target: task.target,
        status: "timeout",
        response: response || "[no response before timeout]",
        durationMs: Date.now() - startMs,
        toolCalls,
      });
    }, TIMEOUT_MS);

    const handler = (event: MessageEvent) => {
      const msg = JSON.parse(typeof event.data === "string" ? event.data : "{}");
      if (msg.type !== "event") return;

      const { event: evt, payload } = msg;
      switch (evt) {
        case "agent:thinking":
          console.log(`  [thinking...]`);
          break;
        case "tool:start":
          toolCalls++;
          console.log(`  [tool] ${payload.tool}(${JSON.stringify(payload.input || {}).slice(0, 80)})`);
          break;
        case "tool:result":
          console.log(`  [result] ${payload.tool} (${payload.durationMs}ms) ${(payload.output || "").slice(0, 60)}`);
          break;
        case "agent:stream":
          if (payload.final) {
            response = payload.chunk || "";
            console.log(`\n  [FINAL RESPONSE] ${response.slice(0, 200)}...`);
            clearTimeout(deadline);
            ws.removeEventListener("message", handler);

            // Destroy session
            ws.send(JSON.stringify({ type: "session:destroy", sessionId }));

            resolve({
              issueNumber: task.issueNumber,
              target: task.target,
              status: "success",
              response,
              durationMs: Date.now() - startMs,
              toolCalls,
            });
          } else {
            // Intermediate stream
            const chunk = (payload.chunk || "").slice(0, 100);
            if (chunk.length > 0) console.log(`  [stream] ${chunk}`);
          }
          break;
        case "agent:error":
          console.log(`  [ERROR] ${payload.error}`);
          clearTimeout(deadline);
          ws.removeEventListener("message", handler);
          ws.send(JSON.stringify({ type: "session:destroy", sessionId }));
          resolve({
            issueNumber: task.issueNumber,
            target: task.target,
            status: "error",
            response: payload.error,
            durationMs: Date.now() - startMs,
            toolCalls,
          });
          break;
      }
    };

    ws.addEventListener("message", handler);
  });
}

async function main() {
  console.log("8gent Issue Dispatcher");
  console.log("=".repeat(70));
  console.log(`Local model:  eight-1-q-14b:latest (Qwen 3 14B fine-tuned)`);
  console.log(`Vessel model: nvidia/nemotron-3-super-120b-a12b:free`);
  console.log(`Tasks: ${assignments.length} issues to dispatch`);
  console.log(`Timeout: ${TIMEOUT_MS / 1000}s per task`);
  console.log("=".repeat(70));

  // Connect to both daemons
  console.log("\nConnecting to daemons...");
  let localWs: WebSocket | null = null;
  let vesselWs: WebSocket | null = null;

  try {
    localWs = await connectDaemon(LOCAL_URL);
    console.log("  Local daemon: connected");
  } catch (err) {
    console.error("  Local daemon: FAILED", err);
  }

  try {
    vesselWs = await connectDaemon(VESSEL_URL);
    console.log("  Vessel daemon: connected");
  } catch (err) {
    console.error("  Vessel daemon: FAILED", err);
  }

  const results: TaskResult[] = [];

  // Execute tasks sequentially per target to avoid session conflicts
  // But local and vessel can run in parallel
  const localTasks = assignments.filter((t) => t.target === "local");
  const vesselTasks = assignments.filter((t) => t.target === "vessel");

  const runTasks = async (ws: WebSocket | null, tasks: TaskAssignment[], label: string) => {
    if (!ws) {
      console.log(`\nSkipping ${label} tasks - daemon not connected`);
      return;
    }
    for (const task of tasks) {
      try {
        const result = await executeTask(ws, task);
        results.push(result);
      } catch (err) {
        console.error(`  Task #${task.issueNumber} failed:`, err);
        results.push({
          issueNumber: task.issueNumber,
          target: task.target,
          status: "error",
          response: String(err),
          durationMs: 0,
          toolCalls: 0,
        });
      }
    }
  };

  // Run local and vessel tasks in parallel
  await Promise.all([
    runTasks(localWs, localTasks, "local"),
    runTasks(vesselWs, vesselTasks, "vessel"),
  ]);

  // Summary
  console.log("\n\n" + "=".repeat(70));
  console.log("DISPATCH RESULTS");
  console.log("=".repeat(70));

  for (const r of results) {
    const icon = r.status === "success" ? "PASS" : r.status === "timeout" ? "TIME" : "FAIL";
    console.log(`  [${icon}] #${r.issueNumber} (${r.target}) - ${r.toolCalls} tools, ${Math.round(r.durationMs / 1000)}s`);
    if (r.status !== "success") {
      console.log(`         ${r.response.slice(0, 120)}`);
    }
  }

  const passed = results.filter((r) => r.status === "success").length;
  console.log(`\n${passed}/${results.length} tasks completed successfully`);
  console.log("=".repeat(70));

  // Write results to file for review
  const resultPath = "/tmp/dispatch-results.json";
  await Bun.write(resultPath, JSON.stringify(results, null, 2));
  console.log(`\nFull results written to ${resultPath}`);

  // Cleanup
  localWs?.close();
  vesselWs?.close();
  process.exit(passed === results.length ? 0 : 1);
}

main().catch((err) => {
  console.error("Fatal:", err);
  process.exit(1);
});
