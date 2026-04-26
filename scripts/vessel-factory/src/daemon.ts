/**
 * 8GI Officer Vessel Daemon
 *
 * Shared runtime for all 8 officer vessels.
 * Identity, soul, and tools are injected via env vars.
 *
 * Endpoints:
 *   GET  /health    - liveness probe
 *   GET  /manifest  - vessel identity + tool list
 *   POST /invoke    - execute a task (from orchestrator)
 *   WS   control plane auto-connect
 */

import { connectControlPlane } from "./control-plane";
import { vesselInvoke } from "./invoke";
import { buildManifest } from "./manifest";

const PORT = Number.parseInt(process.env.PORT ?? "8080");

const VESSEL_CODE = process.env.VESSEL_CODE ?? "???";
const VESSEL_NAME = process.env.VESSEL_NAME ?? "Unknown";
const VESSEL_TITLE = process.env.VESSEL_TITLE ?? "Officer";
const FLY_APP = process.env.FLY_APP_NAME ?? `${VESSEL_CODE.toLowerCase()}-vessel`;
const PUBLIC_URL = `https://${FLY_APP}.fly.dev`;

// ── HTTP Server ───────────────────────────────────────────────────────────

const server = Bun.serve({
	port: PORT,

	async fetch(req) {
		const url = new URL(req.url);
		const path = url.pathname;

		// CORS for claude.ai and control plane
		const corsHeaders = {
			"Access-Control-Allow-Origin": "*",
			"Access-Control-Allow-Methods": "GET, POST, OPTIONS",
			"Access-Control-Allow-Headers": "Content-Type, Authorization",
		};

		if (req.method === "OPTIONS") {
			return new Response(null, { status: 204, headers: corsHeaders });
		}

		// ── GET /health ──────────────────────────────────────────────────────
		if (path === "/health" && req.method === "GET") {
			return Response.json(
				{
					status: "ok",
					vessel: VESSEL_NAME,
					code: VESSEL_CODE,
					ts: Date.now(),
				},
				{ headers: corsHeaders },
			);
		}

		// ── GET /manifest ────────────────────────────────────────────────────
		if (path === "/manifest" && req.method === "GET") {
			return Response.json(buildManifest(), { headers: corsHeaders });
		}

		// ── POST /invoke ─────────────────────────────────────────────────────
		if (path === "/invoke" && req.method === "POST") {
			let body: { task?: string; context?: string; from?: string } = {};
			try {
				body = await req.json();
			} catch {
				return Response.json({ error: "Invalid JSON" }, { status: 400, headers: corsHeaders });
			}

			if (!body.task) {
				return Response.json(
					{ error: "Missing 'task' field" },
					{ status: 400, headers: corsHeaders },
				);
			}

			const result = await vesselInvoke({
				task: body.task,
				context: body.context ?? "",
				from: body.from ?? "orchestrator",
			});

			return Response.json(result, { headers: corsHeaders });
		}

		return new Response("Not Found", { status: 404 });
	},
});

console.log(`[${VESSEL_CODE}] ${VESSEL_NAME} vessel running on :${PORT}`);
console.log(`[${VESSEL_CODE}] Public URL: ${PUBLIC_URL}`);

// ── Control Plane Connection ──────────────────────────────────────────────

connectControlPlane();

// ── Graceful Shutdown ─────────────────────────────────────────────────────

process.on("SIGTERM", () => {
	console.log(`[${VESSEL_CODE}] SIGTERM received - shutting down`);
	server.stop();
	process.exit(0);
});
