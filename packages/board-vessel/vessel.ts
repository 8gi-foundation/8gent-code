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
 *   BOARD_MEMBER_CODE   - member code (8EO, 8TO, 8PO, 8DO, 8SO, 8CO)
 *   VESSEL_AUTH_TOKEN   - shared secret for control plane auth (only when CONTROL_PLANE_URL is set)
 *
 * Optional env:
 *   CONTROL_PLANE_URL   - WebSocket URL (default ws://control-plane.example.internal:3100; in
 *                         direct mode the default is none, an officer vessel)
 *   INFERENCE_MODE      - proxy | ollama | direct | openrouter (direct, pinned to OpenRouter)
 *   VESSEL_PROVIDER     - direct mode: minimax (MINIMAX_API_KEY) | openrouter (OPENROUTER_API_KEY)
 *   VESSEL_MODEL        - the officer's model; required in direct mode, checked against
 *                         the provider's own live list at boot (falls back to OLLAMA_MODEL)
 *   VESSEL_BOOT_PROBE   - "1" runs one harmless round trip at boot, reported on /health
 *   HEALTH_PORT         - health check port (default: 8080)
 */

import type { BoardTask, VesselStatus } from "../board-plane/types";
import { startHealthServer } from "./health-server";
import { generateResponse, modelIsListed } from "./inference";
import { VesselClient } from "./vessel-client";

// -- Read config from env --
const AUTH_TOKEN = process.env.VESSEL_AUTH_TOKEN || "";
const MEMBER_CODE = process.env.BOARD_MEMBER_CODE || "";
const INFERENCE_MODE = process.env.INFERENCE_MODE || "proxy";
const IS_DIRECT = INFERENCE_MODE === "direct" || INFERENCE_MODE === "openrouter";
// Board vessels (proxy, ollama) keep the board-plane default that
// scripts/board-vessel/fly.toml relies on. Officer vessels (direct) have none
// unless one is set.
const DEFAULT_CONTROL_PLANE_URL = "ws://control-plane.example.internal:3100";
const CONTROL_PLANE_URL =
	process.env.CONTROL_PLANE_URL || (IS_DIRECT ? "" : DEFAULT_CONTROL_PLANE_URL);
const VESSEL_PROVIDER = IS_DIRECT
	? INFERENCE_MODE === "openrouter"
		? "openrouter"
		: process.env.VESSEL_PROVIDER || ""
	: "";
const VESSEL_MODEL =
	process.env.VESSEL_MODEL || process.env.OLLAMA_MODEL || (IS_DIRECT ? "" : "qwen3:latest");
const HEALTH_PORT = Number.parseInt(process.env.HEALTH_PORT || "8080", 10);

// Security: delete secrets from env after reading
process.env.VESSEL_AUTH_TOKEN = undefined;

// -- Validate required config --
if (CONTROL_PLANE_URL && !AUTH_TOKEN) {
	console.error("[vessel] VESSEL_AUTH_TOKEN is required when CONTROL_PLANE_URL is set");
	process.exit(1);
}
if (!MEMBER_CODE) {
	console.error("[vessel] BOARD_MEMBER_CODE is required");
	process.exit(1);
}
if (IS_DIRECT && !VESSEL_MODEL) {
	console.error("[vessel] VESSEL_MODEL is required in direct mode");
	process.exit(1);
}

// -- State --
const startTime = Date.now();
let currentTaskId: string | null = null;
let inferenceReady = false;
let probe: { ok: boolean; ms?: number; reply?: string; error?: string; at: string } | null = null;

// -- Wait for inference backend to become available --
async function waitForInference(maxRetries = 30): Promise<boolean> {
	if (IS_DIRECT) {
		// Fail closed: an unknown provider, missing key, unreadable list or
		// unlisted model all stop the vessel before it takes work.
		try {
			const listed = await modelIsListed(VESSEL_MODEL);
			if (!listed)
				console.error(`[vessel] ${VESSEL_MODEL} is not on ${VESSEL_PROVIDER}'s live list`);
			return listed;
		} catch (err) {
			console.error(`[vessel] Model check failed: ${(err as Error).message}`);
			return false;
		}
	}
	if (INFERENCE_MODE === "proxy") {
		// Model proxy mode - check proxy health
		const proxyUrl = process.env.MODEL_PROXY_URL || "http://model-proxy.example.internal:3200";
		for (let i = 0; i < maxRetries; i++) {
			try {
				const res = await fetch(`${proxyUrl}/health`);
				if (res.ok) {
					console.log(`[vessel] Model proxy ready at ${proxyUrl}`);
					return true;
				}
			} catch {
				/* not ready */
			}
			console.log(`[vessel] Waiting for model proxy... (${i + 1}/${maxRetries})`);
			await Bun.sleep(2000);
		}
		console.error("[vessel] Model proxy unreachable after max retries");
		return false;
	}
	// Ollama mode - wait for local Ollama
	for (let i = 0; i < maxRetries; i++) {
		try {
			const res = await fetch("http://localhost:11434/api/tags");
			if (res.ok) {
				const data = (await res.json()) as any;
				console.log(`[vessel] Ollama ready - ${data.models?.length ?? 0} models`);
				return true;
			}
		} catch {
			/* not ready */
		}
		console.log(`[vessel] Waiting for Ollama... (${i + 1}/${maxRetries})`);
		await Bun.sleep(2000);
	}
	console.error("[vessel] Ollama failed to start");
	return false;
}

// -- Vessel status for heartbeats and health checks --
function getStatus(): VesselStatus {
	return {
		memberCode: MEMBER_CODE,
		ollamaReady: inferenceReady,
		modelLoaded: inferenceReady,
		currentTaskId,
		uptimeSeconds: Math.floor((Date.now() - startTime) / 1000),
		memoryMb: Math.floor(process.memoryUsage.rss() / 1024 / 1024),
	};
}

/** /health body: the heartbeat status plus what an operator needs to trust the vessel. */
function getHealth(): Record<string, unknown> {
	return {
		...getStatus(),
		mode: INFERENCE_MODE,
		provider: VESSEL_PROVIDER || null,
		model: VESSEL_MODEL,
		controlPlane: CONTROL_PLANE_URL ? "configured" : "none",
		probe,
	};
}

/** One harmless round trip so /health proves inference, not just liveness. */
async function bootProbe(): Promise<void> {
	const t0 = Date.now();
	try {
		const r = await generateResponse({
			systemPrompt: "Reply with the single word OK.",
			contextMessages: [],
			userMessage: "Health check.",
			model: VESSEL_MODEL,
			maxTokens: 400,
		});
		// "No response generated." is the empty-content fallback; only a real OK counts.
		const ok = /\bok\b/i.test(r.response);
		probe = {
			ok,
			ms: Date.now() - t0,
			reply: r.response.slice(0, 40),
			at: new Date().toISOString(),
		};
		console.log(`[vessel] Boot probe ${ok ? "ok" : "FAILED"} in ${probe.ms}ms`);
	} catch (err) {
		probe = {
			ok: false,
			error: (err as Error).message.slice(0, 200),
			at: new Date().toISOString(),
		};
		console.error(`[vessel] Boot probe failed: ${probe.error}`);
	}
}

// -- Task handler --
async function handleTask(task: BoardTask): Promise<string> {
	currentTaskId = task.id;
	try {
		const result = await generateResponse({
			systemPrompt: task.systemPrompt,
			contextMessages: task.contextMessages || [],
			userMessage: task.content,
			model: VESSEL_MODEL,
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
	console.log(
		`[vessel] Mode: ${INFERENCE_MODE}${VESSEL_PROVIDER ? `/${VESSEL_PROVIDER}` : ""}, model: ${VESSEL_MODEL}`,
	);
	console.log(`[vessel] Control plane: ${CONTROL_PLANE_URL || "none"}`);

	// Wait for inference backend (proxy, Ollama, or the model on OpenRouter's list)
	inferenceReady = await waitForInference();
	if (!inferenceReady) {
		process.exit(1);
	}

	// Start health server
	startHealthServer(HEALTH_PORT, getHealth);

	if (process.env.VESSEL_BOOT_PROBE === "1") await bootProbe();

	// Connect to control plane, when there is one
	const client = CONTROL_PLANE_URL
		? new VesselClient(CONTROL_PLANE_URL, AUTH_TOKEN, MEMBER_CODE, handleTask, getStatus)
		: null;
	client?.connect();

	// Graceful shutdown
	const shutdown = () => {
		console.log("[vessel] Shutting down...");
		client?.close();
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
