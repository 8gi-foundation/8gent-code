/**
 * Minimal HTTP health check server for Fly.io.
 *
 * Returns vessel status as JSON on /health, 404 otherwise.
 */

export function startHealthServer(port: number, getStatus: () => Record<string, unknown>): void {
	Bun.serve({
		port,
		hostname: "0.0.0.0",
		fetch(req) {
			const url = new URL(req.url);
			if (url.pathname === "/health" || url.pathname === "/") {
				const status = getStatus();
				return Response.json({ ok: true, ...status });
			}
			return new Response("Not found", { status: 404 });
		},
	});
	console.log(`[vessel] Health server listening on :${port}`);
}
