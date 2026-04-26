/**
 * LinkedIn Vessel - Main entry point.
 *
 * HTTP server with:
 *   POST /mcp        - MCP tool calls (JSON-RPC)
 *   GET  /health     - health check for Fly.io + control plane
 *   GET  /manifest   - tool manifest for control plane registration
 *
 * WebSocket client to control plane:
 *   Registers this vessel on startup
 *   Receives proxied tool calls from 8gent-code clients
 *   Reconnects automatically on disconnect
 */

import { startReflectionLoop, stopReflectionLoop } from "./hyperagent";
import { TOOL_DEFINITIONS, dispatchTool, handleMCPRequest } from "./mcp-server";
import type { VesselManifest } from "./types";

const PORT = Number.parseInt(process.env.HEALTH_PORT || "8080");
const VESSEL_ID =
	process.env.VESSEL_ID || `linkedin-vessel-${Date.now().toString(36)}`;
const CONTROL_PLANE_URL =
	process.env.CONTROL_PLANE_URL || "wss://8gi-board-plane.fly.dev";
const PUBLIC_URL = process.env.PUBLIC_URL || "https://linkedin-vessel.fly.dev";

// ── Control Plane WebSocket ───────────────────────────────────────────

let cpWs: WebSocket | null = null;
let cpReconnectTimer: ReturnType<typeof setTimeout> | null = null;

function connectToControlPlane(): void {
	if (cpWs?.readyState === WebSocket.OPEN) return;

	try {
		cpWs = new WebSocket(
			`${CONTROL_PLANE_URL}?vesselId=${VESSEL_ID}&type=linkedin`,
		);

		cpWs.onopen = () => {
			console.log(`[control-plane] Connected to ${CONTROL_PLANE_URL}`);

			// Register this vessel's manifest
			const manifest: VesselManifest = {
				vesselId: VESSEL_ID,
				vesselType: "linkedin",
				tools: TOOL_DEFINITIONS.map((t) => t.name),
				endpoint: `${PUBLIC_URL}/mcp`,
				healthUrl: `${PUBLIC_URL}/health`,
				registeredAt: new Date().toISOString(),
			};

			cpWs?.send(JSON.stringify({ type: "vessel:register", manifest }));
		};

		cpWs.onmessage = async (event) => {
			try {
				const msg = JSON.parse(event.data as string);

				// Control plane proxies MCP tool calls to us
				if (msg.type === "mcp:call") {
					const result = await dispatchTool(msg.call);
					cpWs?.send(
						JSON.stringify({
							type: "mcp:result",
							requestId: msg.requestId,
							result,
						}),
					);
				}

				if (msg.type === "ping") {
					cpWs?.send(JSON.stringify({ type: "pong", vesselId: VESSEL_ID }));
				}
			} catch (e: any) {
				console.error("[control-plane] Message error:", e.message);
			}
		};

		cpWs.onclose = () => {
			console.log("[control-plane] Disconnected. Reconnecting in 10s...");
			cpReconnectTimer = setTimeout(connectToControlPlane, 10_000);
		};

		cpWs.onerror = (e) => {
			console.error("[control-plane] WS error:", e);
		};
	} catch (e: any) {
		console.error("[control-plane] Connect failed:", e.message);
		cpReconnectTimer = setTimeout(connectToControlPlane, 15_000);
	}
}

// ── HTTP Server ───────────────────────────────────────────────────────

const server = Bun.serve({
	port: PORT,

	async fetch(req) {
		const url = new URL(req.url);

		// CORS for claude.ai web connector
		const corsHeaders = {
			"Access-Control-Allow-Origin": "https://claude.ai",
			"Access-Control-Allow-Methods": "GET, POST, OPTIONS",
			"Access-Control-Allow-Headers": "Content-Type, Authorization",
		};

		if (req.method === "OPTIONS") {
			return new Response(null, { status: 204, headers: corsHeaders });
		}

		// ── Health ──
		if (url.pathname === "/health") {
			return Response.json(
				{
					status: "ok",
					vesselId: VESSEL_ID,
					vesselType: "linkedin",
					controlPlane:
						cpWs?.readyState === WebSocket.OPEN ? "connected" : "disconnected",
					tools: TOOL_DEFINITIONS.length,
					uptime: process.uptime(),
				},
				{ headers: corsHeaders },
			);
		}

		// ── Tool manifest (for control plane auto-discovery) ──
		if (url.pathname === "/manifest") {
			const manifest: VesselManifest = {
				vesselId: VESSEL_ID,
				vesselType: "linkedin",
				tools: TOOL_DEFINITIONS.map((t) => t.name),
				endpoint: `${PUBLIC_URL}/mcp`,
				healthUrl: `${PUBLIC_URL}/health`,
				registeredAt: new Date().toISOString(),
			};
			return Response.json(manifest, { headers: corsHeaders });
		}

		// ── MCP endpoint ──
		if (url.pathname === "/mcp" && req.method === "POST") {
			const body = await req.json();

			// Synchronous MCP messages (initialize, tools/list)
			const syncResult = handleMCPRequest(body);
			if (syncResult) {
				return Response.json(syncResult, { headers: corsHeaders });
			}

			// Async tool call
			if (body.method === "tools/call") {
				const result = await dispatchTool({
					name: body.params?.name,
					arguments: body.params?.arguments || {},
				});

				return Response.json(
					{
						jsonrpc: "2.0",
						id: body.id,
						result,
					},
					{ headers: corsHeaders },
				);
			}

			return Response.json(
				{
					jsonrpc: "2.0",
					id: body.id,
					error: { code: -32601, message: "Method not found" },
				},
				{ status: 404, headers: corsHeaders },
			);
		}

		return new Response("LinkedIn Vessel - 8gent infrastructure", {
			headers: { ...corsHeaders, "content-type": "text/plain" },
		});
	},
});

// ── Startup ───────────────────────────────────────────────────────────

console.log(`[linkedin-vessel] Starting on port ${PORT}`);
console.log(`[linkedin-vessel] Vessel ID: ${VESSEL_ID}`);
console.log(
	`[linkedin-vessel] Tools: ${TOOL_DEFINITIONS.map((t) => t.name).join(", ")}`,
);

// Start HyperAgent reflection loop
startReflectionLoop();

// Connect to control plane (non-blocking - vessel works standalone too)
connectToControlPlane();

// Graceful shutdown
process.on("SIGTERM", () => {
	console.log("[linkedin-vessel] SIGTERM - shutting down");
	stopReflectionLoop();
	if (cpReconnectTimer) clearTimeout(cpReconnectTimer);
	cpWs?.close();
	server.stop();
});

process.on("SIGINT", () => process.emit("SIGTERM" as any));

console.log(`[linkedin-vessel] Ready. MCP endpoint: ${PUBLIC_URL}/mcp`);
