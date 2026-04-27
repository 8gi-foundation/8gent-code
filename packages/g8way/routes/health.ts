/**
 * @8gent/g8way - GET /healthz
 *
 * Liveness check for the load balancer. Always returns 200 when the
 * process is up; deeper checks (OpenRouter reachability, Clerk JWKS
 * fetch) live behind /readyz so they don't kill the pod on a transient
 * upstream blip.
 */

import type { Hono } from "hono";

export function registerHealthRoute(app: Hono): void {
	app.get("/healthz", (c) => c.json({ status: "ok", service: "g8way", version: "0.1.0" }));
}
