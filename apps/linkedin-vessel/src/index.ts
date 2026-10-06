/**
 * LinkedIn Vessel - Main entry point.
 *
 * HTTP routes:
 *   GET  /health                 - public, minimal liveness only
 *   GET  /manifest               - MCP token
 *   POST /mcp                    - MCP token. Reads run; writes are queued for approval.
 *   GET  /queue                  - approver token. Pending items with full text.
 *   POST /queue/:id/approve      - approver token. Runs the item if caps allow.
 *   POST /queue/:id/reject       - approver token.
 *   GET  /activity               - approver token. Append-only log, previews only.
 *
 * Opt-in background work (both off unless enabled, both stopped by the kill switch):
 *   CONTROL_PLANE_URL set      - outbound WebSocket to the control plane
 *   HYPERAGENT_ENABLED=1       - 6-hourly template rewrite loop
 *
 * Kill switch: LINKEDIN_VESSEL_KILL=1 stops every tool call and every approval.
 */

import { startReflectionLoop, stopReflectionLoop } from "./hyperagent";
import { TOOL_DEFINITIONS, dispatchTool, getQueue, handleMCPRequest } from "./mcp-server";
import { type TokenRole, authorize, isKilled, requestAllowed } from "./policy";
import { listPending, readActivity } from "./queue";
import type { VesselManifest } from "./types";

const PORT = Number.parseInt(process.env.HEALTH_PORT || "8080");
const VESSEL_ID = process.env.VESSEL_ID || `linkedin-vessel-${Date.now().toString(36)}`;
const CONTROL_PLANE_URL = process.env.CONTROL_PLANE_URL || "";
const PUBLIC_URL = process.env.PUBLIC_URL || "https://linkedin-vessel.fly.dev";

const corsHeaders = {
	"Access-Control-Allow-Origin": "https://claude.ai",
	"Access-Control-Allow-Methods": "GET, POST, OPTIONS",
	"Access-Control-Allow-Headers": "Content-Type, Authorization",
};

function json(body: unknown, status = 200, extra: Record<string, string> = {}): Response {
	return Response.json(body, { status, headers: { ...corsHeaders, ...extra } });
}

function guard(req: Request, role: TokenRole): Response | null {
	if (!requestAllowed()) return json({ error: "Too many requests" }, 429, { "Retry-After": "60" });
	const auth = authorize(req, role);
	if (auth.ok) return null;
	const headers: Record<string, string> =
		auth.status === 401 ? { "WWW-Authenticate": 'Bearer realm="linkedin-vessel"' } : {};
	return json({ error: auth.message }, auth.status, headers);
}

function manifest(): VesselManifest {
	return {
		vesselId: VESSEL_ID,
		vesselType: "linkedin",
		tools: TOOL_DEFINITIONS.map((t) => t.name),
		endpoint: `${PUBLIC_URL}/mcp`,
		healthUrl: `${PUBLIC_URL}/health`,
		registeredAt: new Date().toISOString(),
	};
}

const QUEUE_ACTION = /^\/queue\/([0-9a-f-]{36})\/(approve|reject)$/;

export async function handleRequest(req: Request): Promise<Response> {
	const url = new URL(req.url);

	if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: corsHeaders });

	if (url.pathname === "/health") {
		return json({ status: "ok", vesselType: "linkedin", paused: isKilled() });
	}

	if (url.pathname === "/manifest") {
		return guard(req, "mcp") ?? json(manifest());
	}

	if (url.pathname === "/mcp" && req.method === "POST") {
		const denied = guard(req, "mcp");
		if (denied) return denied;

		let body: any;
		try {
			body = await req.json();
		} catch {
			return json(
				{ jsonrpc: "2.0", id: null, error: { code: -32700, message: "Parse error" } },
				400,
			);
		}

		const syncResult = handleMCPRequest(body);
		if (syncResult) return json(syncResult);

		if (body?.method === "tools/call") {
			const result = await dispatchTool({
				name: body.params?.name,
				arguments: body.params?.arguments || {},
			});
			return json({ jsonrpc: "2.0", id: body.id, result });
		}

		return json(
			{
				jsonrpc: "2.0",
				id: body?.id ?? null,
				error: { code: -32601, message: "Method not found" },
			},
			404,
		);
	}

	if (url.pathname === "/queue" && req.method === "GET") {
		return guard(req, "approver") ?? json({ pending: listPending() });
	}

	if (url.pathname === "/activity" && req.method === "GET") {
		const denied = guard(req, "approver");
		if (denied) return denied;
		const limit = Number.parseInt(url.searchParams.get("limit") || "100", 10) || 100;
		return json({ activity: readActivity(limit) });
	}

	const qm = QUEUE_ACTION.exec(url.pathname);
	if (qm && req.method === "POST") {
		const denied = guard(req, "approver");
		if (denied) return denied;
		const [, id, action] = qm;
		const outcome = action === "approve" ? await getQueue().approve(id) : getQueue().reject(id);
		if (outcome.ok) return json({ ok: true, message: outcome.message, item: outcome.item });
		const headers: Record<string, string> = outcome.retryAfterS
			? { "Retry-After": String(outcome.retryAfterS) }
			: {};
		return json({ ok: false, message: outcome.message }, outcome.status, headers);
	}

	return new Response("Not found", {
		status: 404,
		headers: { ...corsHeaders, "content-type": "text/plain" },
	});
}

// ── Control Plane WebSocket (opt-in) ──────────────────────────────────
// Tool calls arriving here go through dispatchTool, so writes are still queued
// for approval and the kill switch still applies.

let cpWs: WebSocket | null = null;
let cpReconnectTimer: ReturnType<typeof setTimeout> | null = null;

function connectToControlPlane(): void {
	if (!CONTROL_PLANE_URL || isKilled()) return;
	if (cpWs?.readyState === WebSocket.OPEN) return;

	try {
		cpWs = new WebSocket(`${CONTROL_PLANE_URL}?vesselId=${VESSEL_ID}&type=linkedin`);

		cpWs.onopen = () => {
			console.log(`[control-plane] Connected to ${CONTROL_PLANE_URL}`);
			cpWs?.send(JSON.stringify({ type: "vessel:register", manifest: manifest() }));
		};

		cpWs.onmessage = async (event) => {
			try {
				const msg = JSON.parse(event.data as string);
				if (msg.type === "mcp:call") {
					const result = await dispatchTool(msg.call);
					cpWs?.send(JSON.stringify({ type: "mcp:result", requestId: msg.requestId, result }));
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

// ── Startup ───────────────────────────────────────────────────────────

if (import.meta.main) {
	const server = Bun.serve({ port: PORT, fetch: handleRequest });

	console.log(`[linkedin-vessel] Starting on port ${PORT}`);
	console.log(`[linkedin-vessel] Vessel ID: ${VESSEL_ID}`);
	console.log(`[linkedin-vessel] Paused (kill switch): ${isKilled()}`);

	if (process.env.HYPERAGENT_ENABLED === "1" && !isKilled()) startReflectionLoop();
	connectToControlPlane();

	process.on("SIGTERM", () => {
		console.log("[linkedin-vessel] SIGTERM - shutting down");
		stopReflectionLoop();
		if (cpReconnectTimer) clearTimeout(cpReconnectTimer);
		cpWs?.close();
		server.stop();
	});

	process.on("SIGINT", () => process.emit("SIGTERM" as any));

	console.log(`[linkedin-vessel] Ready. MCP endpoint: ${PUBLIC_URL}/mcp`);
}
