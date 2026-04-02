/**
 * Board Vessel - Main entry point.
 *
 * A vessel worker that connects to the Control Plane via WebSocket,
 * receives tasks, generates responses via local Ollama, and sends
 * results back. No direct Discord access.
 *
 * Usage: bun run packages/board-vessel/vessel.ts
 *
 * Required env:
 *   VESSEL_AUTH_TOKEN   - shared secret for control plane auth
 *   BOARD_MEMBER_CODE   - member code (8EO, 8TO, 8PO, 8DO, 8SO, 8CO)
 *
 * Optional env:
 *   CONTROL_PLANE_URL   - WebSocket URL (default: ws://8gi-board-plane.internal:3100)
 *   OLLAMA_MODEL        - model to use (default: qwen3:latest)
 *   HEALTH_PORT         - health check port (default: 8080)
 */

import type { BoardTask, VesselStatus } from "../board-plane/types";
import { generateResponse } from "./inference";
import { startHealthServer } from "./health-server";
import { VesselClient } from "./vessel-client";

// -- Read config from env --
const CONTROL_PLANE_URL =
  process.env.CONTROL_PLANE_URL || "ws://8gi-board-plane.internal:3100";
const AUTH_TOKEN = process.env.VESSEL_AUTH_TOKEN || "";
const MEMBER_CODE = process.env.BOARD_MEMBER_CODE || "";
const OLLAMA_MODEL = process.env.OLLAMA_MODEL || "qwen3:latest";
const HEALTH_PORT = parseInt(process.env.HEALTH_PORT || "8080", 10);

// Security: delete secrets from env after reading
delete process.env.VESSEL_AUTH_TOKEN;

// -- Validate required config --
if (!AUTH_TOKEN) {
  console.error("[vessel] VESSEL_AUTH_TOKEN is required");
  process.exit(1);
}
if (!MEMBER_CODE) {
  console.error("[vessel] BOARD_MEMBER_CODE is required");
  process.exit(1);
}

// -- State --
const startTime = Date.now();
let currentTaskId: string | null = null;
let inferenceReady = false;
const INFERENCE_MODE = process.env.INFERENCE_MODE || "proxy";

// -- Wait for inference backend to become available --
async function waitForInference(maxRetries = 30): Promise<boolean> {
  if (INFERENCE_MODE === "proxy") {
    // Model proxy mode - check proxy health
    const proxyUrl = process.env.MODEL_PROXY_URL || "http://8gi-model-proxy.internal:3200";
    for (let i = 0; i < maxRetries; i++) {
      try {
        const res = await fetch(`${proxyUrl}/health`);
        if (res.ok) {
          console.log(`[vessel] Model proxy ready at ${proxyUrl}`);
          return true;
        }
      } catch { /* not ready */ }
      console.log(`[vessel] Waiting for model proxy... (${i + 1}/${maxRetries})`);
      await Bun.sleep(2000);
    }
    console.error("[vessel] Model proxy unreachable after max retries");
    return false;
  } else {
    // Ollama mode - wait for local Ollama
    for (let i = 0; i < maxRetries; i++) {
      try {
        const res = await fetch("http://localhost:11434/api/tags");
        if (res.ok) {
          const data = await res.json() as any;
          console.log(`[vessel] Ollama ready - ${data.models?.length ?? 0} models`);
          return true;
        }
      } catch { /* not ready */ }
      console.log(`[vessel] Waiting for Ollama... (${i + 1}/${maxRetries})`);
      await Bun.sleep(2000);
    }
    console.error("[vessel] Ollama failed to start");
    return false;
  }
}

// -- Vessel status for heartbeats and health checks --
function getStatus(): VesselStatus {
  return {
    memberCode: MEMBER_CODE,
    inferenceReady,
    modelLoaded: inferenceReady,
    currentTaskId,
    uptimeSeconds: Math.floor((Date.now() - startTime) / 1000),
    memoryMb: Math.floor(process.memoryUsage.rss() / 1024 / 1024),
  };
}

// -- Task handler --
async function handleTask(task: BoardTask): Promise<string> {
  currentTaskId = task.id;
  try {
    const result = await generateResponse({
      systemPrompt: task.systemPrompt,
      contextMessages: task.contextMessages || [],
      userMessage: task.content,
      model: OLLAMA_MODEL,
    });
    console.log(
      `[vessel] Task ${task.id} completed in ${result.durationMs}ms (${result.tokensUsed ?? "?"} tokens)`,
    );
    return result.response;
  } finally {
    currentTaskId = null;
  }
}

// -- Main --
async function main(): Promise<void> {
  console.log(`[vessel] ${MEMBER_CODE} starting...`);
  console.log(`[vessel] Model: ${OLLAMA_MODEL}`);
  console.log(`[vessel] Control plane: ${CONTROL_PLANE_URL}`);

  // Wait for inference backend (proxy or Ollama)
  inferenceReady = await waitForInference();
  if (!inferenceReady) {
    process.exit(1);
  }

  // Start health server
  startHealthServer(HEALTH_PORT, getStatus);

  // Connect to control plane
  const client = new VesselClient(
    CONTROL_PLANE_URL,
    AUTH_TOKEN,
    MEMBER_CODE,
    handleTask,
    getStatus,
  );
  client.connect();

  // Graceful shutdown
  const shutdown = () => {
    console.log("[vessel] Shutting down...");
    client.close();
    process.exit(0);
  };
  process.on("SIGTERM", shutdown);
  process.on("SIGINT", shutdown);

  console.log(`[vessel] ${MEMBER_CODE} online and waiting for tasks`);
}

main().catch((err) => {
  console.error("[vessel] Fatal error:", err);
  process.exit(1);
});
