#!/usr/bin/env bun
/**
 * Query the vessel to report on work it completed.
 */

const VESSEL_URL = "wss://eight-vessel.fly.dev";
const TIMEOUT_MS = 120_000;

async function main() {
  const ws = new WebSocket(VESSEL_URL);
  await new Promise<void>((resolve, reject) => {
    ws.onopen = () => resolve();
    ws.onerror = () => reject(new Error("Connection failed"));
    setTimeout(() => reject(new Error("Timeout")), 10_000);
  });
  console.log("Connected to vessel");

  // Create session
  const sessionPromise = new Promise<string>((resolve) => {
    const handler = (event: MessageEvent) => {
      const msg = JSON.parse(event.data as string);
      if (msg.type === "session:created") {
        ws.removeEventListener("message", handler);
        resolve(msg.sessionId);
      }
    };
    ws.addEventListener("message", handler);
  });
  ws.send(JSON.stringify({ type: "session:create", channel: "delegation" }));
  const sessionId = await sessionPromise;
  console.log(`Session: ${sessionId}`);

  await new Promise((r) => setTimeout(r, 3_000));

  const prompt = `Report on the work done on these branches in this repo (/app/):

1. Run: git branch -a
2. For each feature branch (not main), show:
   - git log main..BRANCH --oneline
   - git diff main..BRANCH --stat
3. If feat/memory-contradictions exists, show the contents of packages/memory/contradictions.ts
4. Show git status

Be thorough. Show the actual file contents and diff stats.`;

  ws.send(JSON.stringify({ type: "prompt", text: prompt }));
  console.log("Prompt sent, waiting for response...\n");

  let response = "";
  await new Promise<void>((resolve) => {
    const timer = setTimeout(() => {
      console.log("\n[TIMEOUT]");
      resolve();
    }, TIMEOUT_MS);

    ws.addEventListener("message", (event: MessageEvent) => {
      const msg = JSON.parse(event.data as string);
      if (msg.type === "event") {
        const { event: evt, payload } = msg;
        if (evt === "tool:start") {
          console.log(`  [tool] ${payload.tool}(${JSON.stringify(payload.input || {}).slice(0, 100)})`);
        } else if (evt === "tool:result") {
          console.log(`  [result] ${(payload.output || "").slice(0, 200)}`);
        } else if (evt === "agent:stream") {
          if (payload.final) {
            response = payload.chunk || "";
            console.log(`\n--- RESPONSE ---\n${response}\n--- END ---`);
            clearTimeout(timer);
            resolve();
          } else if (payload.chunk) {
            process.stdout.write(payload.chunk);
          }
        } else if (evt === "agent:error") {
          console.log(`[ERROR] ${payload.error}`);
          clearTimeout(timer);
          resolve();
        }
      }
    });
  });

  ws.send(JSON.stringify({ type: "session:destroy", sessionId }));
  ws.close();
}

main().catch(console.error);
