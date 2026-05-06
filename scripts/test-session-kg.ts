/**
 * Quick smoke test for Knowledge Graph v1.
 * Run: cd ~/8gent-code && bun run scripts/test-session-kg.ts
 */

import { writeSessionToKG, recallPriorSessionsSync, generateSessionSummary } from "../packages/memory/session-kg.js";

const cwd = process.cwd();
const sessionId = `test_${Date.now()}`;

console.log("─── KG v1 smoke test ───");
console.log(`cwd: ${cwd}`);
console.log(`sessionId: ${sessionId}`);
console.log("");

// 1. Generate a summary
const fakeMessages = [
  { role: "user", content: "Fix the auth bug in the Telegram middleware routing." },
  { role: "assistant", content: "Done. Updated packages/eight/agent.ts and added session-kg.ts." },
];
const fakeFiles = ["packages/eight/agent.ts", "packages/memory/session-kg.ts", "packages/memory/graph.ts"];
const summary = generateSessionSummary(fakeMessages, fakeFiles);
console.log(`Generated summary: "${summary}"`);
console.log("");

// 2. Write to KG
console.log("Writing session to KG...");
await writeSessionToKG({
  sessionId,
  summary,
  cwd,
  filesCreated: new Set(["packages/memory/session-kg.ts"]),
  filesModified: new Set(["packages/eight/agent.ts", "packages/memory/graph.ts"]),
  durationMs: 45_000,
  branch: "feat/computer-use-tool",
});
console.log("Write complete.");
console.log("");

// 3. Recall
console.log("Recalling prior sessions...");
const recalled = recallPriorSessionsSync(cwd, 5);
if (recalled) {
  console.log("RECALL OUTPUT (this goes into system prompt):");
  console.log(recalled);
} else {
  console.log("No sessions recalled — DB may not exist yet.");
}

// 4. Second write to confirm dedup/upsert works
console.log("\nWriting a second session...");
await writeSessionToKG({
  sessionId: `test_${Date.now() + 1}`,
  summary: "Added session-kg recall to system prompt injection.",
  cwd,
  filesCreated: new Set(),
  filesModified: new Set(["packages/eight/agent.ts"]),
  durationMs: 12_000,
  branch: "feat/computer-use-tool",
});

const recalled2 = recallPriorSessionsSync(cwd, 5);
console.log("\nAfter second write:");
console.log(recalled2);
console.log("\n─── done ───");
