/**
 * The live line shown while a turn waits for the model (#133).
 *
 * Ollama sends nothing while it loads a model and reads the prompt, so the
 * screen used to show a bare spinner for minutes. This counts the seconds and,
 * when the local server says the model is not in memory, says it is loading.
 * When it cannot tell, it shows the seconds and the model name only.
 */

/** The line. `loading` true = server confirmed the model is not loaded; null = unknown. */
export function waitStatusLine(model: string, seconds: number, loading: boolean | null): string {
	const who = model.trim() || "the model";
	return loading === true
		? `loading model ${who}, ${seconds} s`
		: `waiting for ${who}, ${seconds} s`;
}

/**
 * Ask a local Ollama server whether `model` is in memory (GET /api/ps, local
 * only). true = loaded, false = not loaded, null = could not tell.
 */
export async function probeModelLoaded(
	baseUrl: string,
	model: string,
	fetchImpl: (url: string, init?: RequestInit) => Promise<Response> = fetch,
): Promise<boolean | null> {
	try {
		const res = await fetchImpl(`${baseUrl.replace(/\/+$/, "")}/api/ps`, {
			signal: AbortSignal.timeout(2_000),
		});
		if (!res.ok) return null;
		const body = (await res.json()) as { models?: { name?: string; model?: string }[] };
		if (!Array.isArray(body.models)) return null;
		const want = model.includes(":") ? model : `${model}:latest`;
		return body.models.some((m) => (m.name ?? m.model) === want);
	} catch {
		return null;
	}
}

export interface FirstOutputWait {
	/** Progress was seen (a step or tool began or ended): restart the count, stop saying "loading". */
	touch(): void;
	stop(): void;
}

/**
 * Start the live count. `onLine` gets a new line every second and null when
 * stopped. `probe` runs once at the start; timers are injectable for tests.
 */
export function startFirstOutputWait(opts: {
	model: string;
	probe?: () => Promise<boolean | null>;
	onLine: (line: string | null) => void;
	setInterval?: (fn: () => void, ms: number) => unknown;
	clearInterval?: (h: unknown) => void;
}): FirstOutputWait {
	const setI = opts.setInterval ?? ((fn, ms) => setInterval(fn, ms));
	const clearI = opts.clearInterval ?? ((h) => clearInterval(h as ReturnType<typeof setInterval>));
	let seconds = 0;
	let loading: boolean | null = null;
	let progressed = false;
	let stopped = false;
	const show = () => opts.onLine(waitStatusLine(opts.model, seconds, progressed ? null : loading));
	const handle = setI(() => {
		seconds += 1;
		show();
	}, 1000);
	void opts.probe?.().then((v) => {
		if (stopped || progressed) return;
		loading = v === false ? true : null;
		show();
	});
	return {
		touch() {
			progressed = true;
			seconds = 0;
			opts.onLine(null);
		},
		stop() {
			stopped = true;
			clearI(handle);
			opts.onLine(null);
		},
	};
}
