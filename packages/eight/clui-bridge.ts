/**
 * 8gent CLUI Bridge — Streaming
 *
 * Talks directly to Ollama API with streaming responses.
 * Reads prompts from stdin, writes NDJSON to stdout.
 * Tokens appear in real-time as they're generated.
 */

import * as readline from "readline";

function emit(event: Record<string, any>) {
	process.stdout.write(JSON.stringify(event) + "\n");
}

const model = process.env.EIGHT_MODEL || "eight:latest";
const sessionId = process.env.EIGHT_SESSION_ID || `clui_${Date.now()}`;
const ollamaUrl = process.env.OLLAMA_URL || "http://localhost:11434";

const history: Array<{ role: string; content: string }> = [
	{
		role: "system",
		content: `You are Eight, the infinite gentleman — an autonomous coding agent. Refined, witty, confident, endlessly capable. Dry British wit. Help users write code, fix bugs, build software. Be concise.`,
	},
];

async function chatStream(prompt: string): Promise<string> {
	history.push({ role: "user", content: prompt });
	process.stderr.write(
		`[bridge] fetching for prompt: "${prompt.substring(0, 30)}"\n`,
	);

	const res = await fetch(`${ollamaUrl}/api/chat`, {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify({
			model,
			messages: history,
			stream: true,
			options: {
				num_predict: 512,
			},
			// Disable thinking mode for qwen/eight models (causes massive delays)
			think: false,
		}),
	});

	process.stderr.write(`[bridge] fetch status: ${res.status}\n`);
	if (!res.ok) {
		throw new Error(`Ollama error ${res.status}: ${await res.text()}`);
	}

	// Read the NDJSON stream line by line
	const reader = res.body?.getReader();
	if (!reader) throw new Error("No response body");

	const decoder = new TextDecoder();
	let fullContent = "";
	let buffer = "";

	while (true) {
		const { done, value } = await reader.read();
		if (done) break;

		buffer += decoder.decode(value, { stream: true });
		const lines = buffer.split("\n");
		buffer = lines.pop() || ""; // Keep incomplete line in buffer

		for (const line of lines) {
			if (!line.trim()) continue;
			try {
				const chunk = JSON.parse(line);
				// Skip thinking tokens (qwen3/eight models emit these before real content)
				if (chunk.message?.role === "assistant" && chunk.message?.content) {
					const token = chunk.message.content;
					// Filter out thinking markers
					if (!token.includes("<think>") && !token.includes("</think>")) {
						fullContent += token;
						emit({ type: "text", content: token });
					}
				}
				if (chunk.done) break;
			} catch {}
		}
	}

	history.push({ role: "assistant", content: fullContent });
	return fullContent;
}

async function main() {
	emit({ type: "session_start", model, cwd: process.cwd(), sessionId });
	emit({ type: "ready", message: "Agent ready. Send prompts via stdin." });

	const rl = readline.createInterface({
		input: process.stdin,
		terminal: false,
	});
	let pending = 0;
	let stdinClosed = false;

	function maybeExit() {
		if (stdinClosed && pending === 0) {
			emit({ type: "session_end", reason: "stdin closed" });
			process.exit(0);
		}
	}

	rl.on("line", async (line: string) => {
		const prompt = line.trim();
		if (!prompt) return;

		pending++;
		emit({ type: "thinking", content: "" });

		try {
			const response = await chatStream(prompt);
			emit({ type: "assistant_message", content: response });
		} catch (err: any) {
			emit({ type: "error", message: err.message || String(err) });
		} finally {
			pending--;
			maybeExit();
		}
	});

	rl.on("close", () => {
		stdinClosed = true;
		maybeExit();
	});

	process.on("SIGTERM", () => {
		emit({ type: "session_end", reason: "SIGTERM" });
		process.exit(0);
	});
}

main().catch((err) => {
	emit({ type: "error", message: `Fatal: ${err.message}` });
	process.exit(1);
});
