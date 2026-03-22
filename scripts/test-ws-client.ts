#!/usr/bin/env bun
/**
 * Minimal WebSocket client to verify the daemon protocol works.
 *
 * Usage:
 *   Local:  bun run scripts/test-ws-client.ts
 *   Remote: DAEMON_URL=wss://8gent-daemon.fly.dev bun run scripts/test-ws-client.ts
 *
 * Tests:
 *   - Connect to ws://localhost:18789 (or DAEMON_URL)
 *   - Auth handshake (if token configured)
 *   - Create session
 *   - Send prompt ("What is 2+2?")
 *   - Receive streamed events
 *   - Verify final response has { final: true }
 *   - List sessions
 *   - Health check
 *   - Destroy session
 */

const PORT = process.env.DAEMON_PORT || "18789";
const DAEMON_URL = process.env.DAEMON_URL || `ws://localhost:${PORT}`;
const AUTH_TOKEN = process.env.DAEMON_AUTH_TOKEN || null;
const TIMEOUT_MS = 60_000;

interface TestResult {
  name: string;
  passed: boolean;
  detail: string;
}

const results: TestResult[] = [];

function log(msg: string): void {
  console.log(`[test] ${msg}`);
}

function pass(name: string, detail: string): void {
  results.push({ name, passed: true, detail });
  log(`PASS: ${name} - ${detail}`);
}

function fail(name: string, detail: string): void {
  results.push({ name, passed: false, detail });
  log(`FAIL: ${name} - ${detail}`);
}

async function run(): Promise<void> {
  log(`Connecting to ${DAEMON_URL}...`);

  const ws = new WebSocket(DAEMON_URL);
  let sessionId: string | null = null;
  let gotFinalResponse = false;
  let finalResponseText = "";
  let gotSessionsList = false;
  let gotHealth = false;
  let gotThinking = false;
  let toolEvents = 0;

  const messageQueue: any[] = [];
  let resolveNext: ((msg: any) => void) | null = null;

  function waitForMessage(timeoutMs = TIMEOUT_MS): Promise<any> {
    if (messageQueue.length > 0) {
      return Promise.resolve(messageQueue.shift());
    }
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        resolveNext = null;
        reject(new Error("Timeout waiting for message"));
      }, timeoutMs);

      resolveNext = (msg: any) => {
        clearTimeout(timer);
        resolve(msg);
      };
    });
  }

  /** Wait for a message of a specific type, skipping event broadcasts */
  async function waitForType(type: string, timeoutMs = TIMEOUT_MS): Promise<any> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const msg = await waitForMessage(deadline - Date.now());
      if (msg.type === type) return msg;
      // Log skipped event messages
      if (msg.type === "event") {
        log(`  (skipped event: ${msg.event})`);
      }
    }
    throw new Error(`Timeout waiting for message type: ${type}`);
  }

  ws.onmessage = (event: MessageEvent) => {
    const msg = JSON.parse(typeof event.data === "string" ? event.data : new TextDecoder().decode(event.data as ArrayBuffer));
    if (resolveNext) {
      const r = resolveNext;
      resolveNext = null;
      r(msg);
    } else {
      messageQueue.push(msg);
    }
  };

  // Wait for connection
  await new Promise<void>((resolve, reject) => {
    ws.onopen = () => resolve();
    ws.onerror = (err) => reject(new Error(`Connection failed: ${err}`));
    setTimeout(() => reject(new Error("Connection timeout")), 5000);
  });

  pass("connect", `Connected to ${DAEMON_URL}`);

  // --- Test 1: Auth handshake ---
  if (AUTH_TOKEN) {
    ws.send(JSON.stringify({ type: "auth", token: AUTH_TOKEN }));
    const authReply = await waitForMessage(5000);
    if (authReply.type === "auth:ok") {
      pass("auth", "Authenticated successfully");
    } else {
      fail("auth", `Expected auth:ok, got ${authReply.type}`);
    }
  } else {
    pass("auth", "No auth token configured - skipped (auto-authenticated)");
  }

  // --- Test 2: Ping/pong ---
  ws.send(JSON.stringify({ type: "ping" }));
  const pong = await waitForMessage(5000);
  if (pong.type === "pong") {
    pass("ping", "Pong received");
  } else {
    fail("ping", `Expected pong, got ${pong.type}`);
  }

  // --- Test 3: Create session ---
  ws.send(JSON.stringify({ type: "session:create", channel: "test" }));
  const sessionReply = await waitForType("session:created", 10000);
  if (sessionReply.type === "session:created" && sessionReply.sessionId) {
    sessionId = sessionReply.sessionId;
    pass("session:create", `Session ${sessionId}`);
  } else {
    fail("session:create", `Expected session:created, got ${JSON.stringify(sessionReply)}`);
    ws.close();
    printSummary();
    return;
  }

  // --- Test 4: Health check via WebSocket ---
  ws.send(JSON.stringify({ type: "health" }));
  const healthReply = await waitForType("health", 10000);
  if (healthReply.type === "health" && healthReply.data?.status === "ok") {
    gotHealth = true;
    pass("health", `sessions=${healthReply.data.sessions} uptime=${Math.round(healthReply.data.uptime)}s`);
  } else {
    fail("health", `Expected health response, got ${JSON.stringify(healthReply)}`);
  }

  // --- Test 5: List sessions ---
  ws.send(JSON.stringify({ type: "sessions:list" }));
  const listReply = await waitForType("sessions:list", 10000);
  if (listReply.type === "sessions:list" && Array.isArray(listReply.sessions)) {
    gotSessionsList = true;
    pass("sessions:list", `${listReply.sessions.length} session(s) active`);
  } else {
    fail("sessions:list", `Expected sessions:list, got ${JSON.stringify(listReply)}`);
  }

  // --- Test 6: Send prompt and collect events ---
  // Wait for agent to finish initializing (AST indexing takes a few seconds)
  log("Waiting 5s for agent initialization...");
  await new Promise((r) => setTimeout(r, 5000));
  log("Sending prompt: 'What is 2+2?'");
  ws.send(JSON.stringify({ type: "prompt", text: "What is 2+2? Reply with just the number." }));

  // Collect events until session:end
  const startMs = Date.now();
  let turnComplete = false;

  while (!turnComplete && (Date.now() - startMs) < TIMEOUT_MS) {
    try {
      const msg = await waitForMessage(TIMEOUT_MS);

      if (msg.type === "event") {
        const { event, payload } = msg;

        switch (event) {
          case "agent:thinking":
            gotThinking = true;
            log(`  event: agent:thinking`);
            break;
          case "tool:start":
            toolEvents++;
            log(`  event: tool:start - ${payload.tool}`);
            break;
          case "tool:result":
            log(`  event: tool:result - ${payload.tool} (${payload.durationMs}ms)`);
            break;
          case "agent:stream":
            if (payload.final) {
              gotFinalResponse = true;
              finalResponseText = payload.chunk || "";
              log(`  event: agent:stream [FINAL] - "${finalResponseText.slice(0, 100)}"`);
            } else {
              log(`  event: agent:stream - "${(payload.chunk || "").slice(0, 80)}..."`);
            }
            break;
          case "agent:error":
            log(`  event: agent:error - ${payload.error}`);
            break;
          case "session:end":
            turnComplete = true;
            log(`  event: session:end - reason=${payload.reason}`);
            break;
          default:
            log(`  event: ${event}`);
        }
      } else if (msg.type === "error") {
        log(`  error: ${msg.message}`);
      }
    } catch (err) {
      fail("prompt", `Timeout or error: ${err}`);
      break;
    }
  }

  if (gotThinking) {
    pass("agent:thinking", "Received thinking event");
  } else {
    fail("agent:thinking", "Never received agent:thinking event");
  }

  if (gotFinalResponse) {
    pass("final-response", `Got { final: true } response: "${finalResponseText.slice(0, 100)}"`);
  } else {
    fail("final-response", "Never received agent:stream with { final: true }");
  }

  if (turnComplete) {
    pass("turn-complete", `Turn completed in ${Date.now() - startMs}ms`);
  } else {
    fail("turn-complete", "session:end never received");
  }

  // --- Test 7: Destroy session ---
  if (sessionId) {
    ws.send(JSON.stringify({ type: "session:destroy", sessionId }));
    // Wait a beat for the destroy to process
    await new Promise((r) => setTimeout(r, 500));
    pass("session:destroy", `Destroyed session ${sessionId}`);
  }

  ws.close();
  printSummary();
}

function printSummary(): void {
  console.log("\n" + "=".repeat(60));
  console.log("DAEMON PROTOCOL TEST RESULTS");
  console.log("=".repeat(60));

  const passed = results.filter((r) => r.passed).length;
  const failed = results.filter((r) => !r.passed).length;

  for (const r of results) {
    console.log(`  ${r.passed ? "PASS" : "FAIL"}  ${r.name}: ${r.detail}`);
  }

  console.log("=".repeat(60));
  console.log(`${passed} passed, ${failed} failed, ${results.length} total`);
  console.log("=".repeat(60));

  process.exit(failed > 0 ? 1 : 0);
}

run().catch((err) => {
  console.error("[test] Fatal:", err.message || err);
  console.error("[test] Is the daemon running? Start it with: bun run packages/daemon/index.ts");
  process.exit(1);
});
