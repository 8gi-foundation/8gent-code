/**
 * grove-mesh-test — exercise the mesh-native peer-to-peer protocol.
 *
 * Unlike grove-test.ts (which uses the standard CLIENT protocol:
 * session:create + prompt), this script speaks the VesselMessage
 * protocol directly. It opens a WebSocket to a peer's gateway, sends
 * a `capability-query` to introduce itself, then sends a `task` and
 * waits for a `result` carrying the same correlationId.
 *
 * Verifies issue #1810 (mesh-native gateway routing).
 *
 * Usage:
 *   bun run scripts/grove-mesh-test.ts wss://grove-peer-a.fly.dev:443 'what is 2+2?'
 */

const target = process.argv[2] || "ws://localhost:18789";
const prompt = process.argv[3] || "say hi from the mesh test";

console.log(`[grove-mesh-test] target=${target}`);
console.log(`[grove-mesh-test] prompt=${prompt}`);

const correlationId = `corr-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
const myVesselId = `mesh-test-${Date.now().toString(36)}`;
const startedAt = Date.now();

const ws = new WebSocket(target);

const ourInfo = {
  id: myVesselId,
  name: "Mesh Test Client",
  url: "ws://localhost:0",
  ownerId: "8gi-foundation",
  capabilities: ["test"],
  model: "none",
  region: "local",
  startedAt,
  lastHeartbeat: startedAt,
  activeSessions: 0,
  maxSessions: 1,
};

let sentTask = false;
const taskSentAt = { value: 0 };

ws.addEventListener("open", () => {
  console.log(`[grove-mesh-test] connected in ${Date.now() - startedAt}ms`);

  ws.send(JSON.stringify({
    id: `q-${Date.now().toString(36)}`,
    from: myVesselId,
    to: "peer",
    type: "capability-query",
    payload: { vesselInfo: ourInfo },
    timestamp: Date.now(),
  }));
  console.log("[grove-mesh-test] capability-query sent");
});

ws.addEventListener("message", (event) => {
  let msg: any;
  try {
    msg = JSON.parse(String(event.data));
  } catch {
    console.log("[grove-mesh-test] non-JSON message");
    return;
  }

  if (msg.type === "capability-response") {
    const peer = msg.payload?.vesselInfo;
    console.log(`[grove-mesh-test] capability-response from ${peer?.id || "unknown"} (model=${peer?.model})`);

    ws.send(JSON.stringify({
      id: `t-${Date.now().toString(36)}`,
      from: myVesselId,
      to: peer?.id || "peer",
      type: "task",
      payload: { prompt, correlationId },
      timestamp: Date.now(),
    }));
    sentTask = true;
    taskSentAt.value = Date.now();
    console.log(`[grove-mesh-test] task sent (correlationId=${correlationId})`);
    return;
  }

  if (msg.type === "result" && msg.correlationId === correlationId) {
    const ttr = Date.now() - taskSentAt.value;
    const total = Date.now() - startedAt;
    console.log(`[grove-mesh-test] RESULT in ${ttr}ms (total=${total}ms)`);
    console.log(`[grove-mesh-test] status=${msg.payload?.status} duration=${msg.payload?.durationMs}ms`);
    console.log(`---`);
    console.log(msg.payload?.output);
    console.log(`---`);
    if (msg.payload?.error) console.log(`[grove-mesh-test] error: ${msg.payload.error}`);
    ws.close();
    process.exit(msg.payload?.status === "completed" ? 0 : 1);
  }
});

ws.addEventListener("error", (err) => {
  console.error("[grove-mesh-test] socket error:", err);
  process.exit(1);
});

setTimeout(() => {
  console.error("[grove-mesh-test] TIMEOUT — no result within 90s");
  ws.close();
  process.exit(1);
}, 90_000);
