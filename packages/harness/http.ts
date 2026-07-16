/**
 * Harness HTTP surface (part of #2797). Mounted by the daemon gateway.
 *
 * Routes:
 *   GET  /harnesses      -> { harnesses: string[], default: "8gent-local" }
 *   POST /harness/run    -> { prompt, harness?, cwd? } => 202 { taskId, harness }
 *   GET  /harness/tasks  -> SSE stream of StatusEvents (replay + live)
 *
 * Returns null for non-harness paths so the gateway falls through to its
 * existing routes untouched.
 */

import { DEFAULT_HARNESS } from "./index";
import { HarnessRunner } from "./runner";

let singleton: HarnessRunner | null = null;

/** Daemon-wide runner. Lazily created so importing this module is free. */
export function getHarnessRunner(): HarnessRunner {
	if (!singleton) singleton = new HarnessRunner();
	return singleton;
}

export function handleHarnessRoute(
	req: Request,
	url: URL,
	runner: HarnessRunner = getHarnessRunner(),
): Promise<Response> | Response | null {
	if (url.pathname === "/harnesses" && req.method === "GET") {
		return Response.json({
			harnesses: runner.registry.list(),
			default: DEFAULT_HARNESS,
		});
	}

	if (url.pathname === "/harness/run" && req.method === "POST") {
		return handleRun(req, runner);
	}

	if (url.pathname === "/harness/tasks" && req.method === "GET") {
		return handleTaskStream(runner);
	}

	return null;
}

async function handleRun(req: Request, runner: HarnessRunner): Promise<Response> {
	let body: { prompt?: unknown; harness?: unknown; cwd?: unknown };
	try {
		body = (await req.json()) as typeof body;
	} catch {
		return Response.json({ error: "invalid JSON body" }, { status: 400 });
	}

	const prompt = typeof body.prompt === "string" ? body.prompt.trim() : "";
	if (!prompt) {
		return Response.json({ error: "prompt is required" }, { status: 400 });
	}

	const harnessName = typeof body.harness === "string" ? body.harness : undefined;
	const cwd = typeof body.cwd === "string" ? body.cwd : undefined;

	try {
		const taskId = runner.start({ prompt, harness: harnessName, cwd });
		return Response.json({ taskId, harness: harnessName ?? DEFAULT_HARNESS }, { status: 202 });
	} catch (err) {
		return Response.json(
			{ error: err instanceof Error ? err.message : String(err) },
			{ status: 400 },
		);
	}
}

function handleTaskStream(runner: HarnessRunner): Response {
	const encoder = new TextEncoder();
	let unsubscribe: (() => void) | null = null;

	const stream = new ReadableStream<Uint8Array>({
		start(controller) {
			const send = (data: string) => {
				try {
					controller.enqueue(encoder.encode(data));
				} catch {
					unsubscribe?.();
					unsubscribe = null;
				}
			};
			// Replay buffered history first so late watchers see the full picture.
			for (const event of runner.allEvents()) {
				send(`data: ${JSON.stringify(event)}\n\n`);
			}
			unsubscribe = runner.subscribe((event) => {
				send(`data: ${JSON.stringify(event)}\n\n`);
			});
		},
		cancel() {
			unsubscribe?.();
			unsubscribe = null;
		},
	});

	return new Response(stream, {
		status: 200,
		headers: {
			"content-type": "text/event-stream",
			"cache-control": "no-cache",
			connection: "keep-alive",
		},
	});
}
