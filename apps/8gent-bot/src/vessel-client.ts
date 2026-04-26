/**
 * Vessel client - wakes and invokes officer vessels via HTTP.
 *
 * Vessels sleep at min_machines=0. First request auto-starts them (Fly.io).
 * Cold start is ~2-4s. We handle the latency gracefully.
 */

interface InvokeRequest {
	task: string;
	context?: string;
	from?: string;
}

interface InvokeResult {
	officer: string;
	response: string;
	model_used?: string;
	latency_ms: number;
	error?: string;
}

// How long to wait for a sleeping vessel to wake up
const WAKE_TIMEOUT_MS = 30_000;

export async function invokeVessel(
	fly_app: string,
	req: InvokeRequest,
): Promise<InvokeResult> {
	const url = `https://${fly_app}.fly.dev/invoke`;
	const start = Date.now();

	try {
		const res = await fetch(url, {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify(req),
			signal: AbortSignal.timeout(WAKE_TIMEOUT_MS),
		});

		if (!res.ok) {
			return {
				officer: fly_app,
				response: `Vessel ${fly_app} returned ${res.status}`,
				latency_ms: Date.now() - start,
				error: await res.text(),
			};
		}

		return (await res.json()) as InvokeResult;
	} catch (err: any) {
		const isTimeout = err?.name === "TimeoutError";
		return {
			officer: fly_app,
			response: isTimeout
				? `${fly_app} is starting up - try again in a few seconds`
				: `${fly_app} unreachable: ${err.message}`,
			latency_ms: Date.now() - start,
			error: err.message,
		};
	}
}

export async function pingVessel(fly_app: string): Promise<boolean> {
	try {
		const res = await fetch(`https://${fly_app}.fly.dev/health`, {
			signal: AbortSignal.timeout(5000),
		});
		return res.ok;
	} catch {
		return false;
	}
}
