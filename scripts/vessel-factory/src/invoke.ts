/**
 * vesselInvoke - core reasoning loop for any officer vessel.
 *
 * 1. Compose system prompt from soul + identity
 * 2. Call model-proxy with conversation
 * 3. Return structured response
 */

const MODEL_PROXY = process.env.MODEL_PROXY_URL ?? "http://8gi-model-proxy.internal:3200";
const MODEL = process.env.VESSEL_MODEL ?? "auto";

export interface InvokeRequest {
	task: string;
	context?: string;
	from?: string;
}

export interface InvokeResult {
	officer: string;
	response: string;
	model_used?: string;
	latency_ms: number;
	error?: string;
}

function buildSystemPrompt(): string {
	const code = process.env.VESSEL_CODE ?? "???";
	const name = process.env.VESSEL_NAME ?? "Officer";
	const title = process.env.VESSEL_TITLE ?? "";
	const soul = process.env.VESSEL_SOUL ?? `You are ${name}, ${title} of 8GI.`;
	const phrase = process.env.VESSEL_CATCHPHRASE ?? "";

	return [
		soul.trim(),
		"",
		`Your code is ${code}. Your title is ${title}.`,
		phrase ? `Your catchphrase: "${phrase}"` : "",
		"",
		"Rules:",
		"- Be direct. No em dashes. No hype.",
		"- Lead with the answer.",
		"- Flag problems before being asked.",
		"- When uncertain, say so with your best reasoning.",
		"- Your responses are read by James on Telegram. Keep them under 2000 chars.",
	]
		.filter((l) => l !== undefined)
		.join("\n");
}

export async function vesselInvoke(req: InvokeRequest): Promise<InvokeResult> {
	const start = Date.now();
	const systemPrompt = buildSystemPrompt();
	const code = process.env.VESSEL_CODE ?? "???";

	const messages = [
		{ role: "system", content: systemPrompt },
		...(req.context ? [{ role: "user", content: `Context: ${req.context}` }] : []),
		{ role: "user", content: req.task },
	];

	try {
		const res = await fetch(`${MODEL_PROXY}/v1/chat/completions`, {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({
				model: MODEL,
				messages,
				max_tokens: 800,
				temperature: 0.7,
			}),
		});

		if (!res.ok) {
			const errText = await res.text();
			return {
				officer: code,
				response: `[${code}] Model proxy error: ${res.status}`,
				latency_ms: Date.now() - start,
				error: errText,
			};
		}

		const data = (await res.json()) as {
			choices?: { message?: { content?: string } }[];
			model?: string;
		};

		const content = data.choices?.[0]?.message?.content ?? "(no response)";

		return {
			officer: code,
			response: content,
			model_used: data.model,
			latency_ms: Date.now() - start,
		};
	} catch (err: any) {
		console.error(`[${code}] Invoke error:`, err.message);
		return {
			officer: code,
			response: `[${code}] Invoke failed: ${err.message}`,
			latency_ms: Date.now() - start,
			error: err.message,
		};
	}
}
