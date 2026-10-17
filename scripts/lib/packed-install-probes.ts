/**
 * Probes for scripts/pack-smoke.ts (#4354-#4356 follow-up).
 *
 * 1. missingAssetReads: a bundle that reads a file by `new URL(rel, import.meta.url)`
 *    or `join/resolve(__dirname, rel)` finds it next to dist/ in a checkout and
 *    nowhere in an npm install. Every such literal read is resolved against the
 *    INSTALLED package and must exist. (Bun bakes `__dirname` as
 *    `import.meta.dir + "<rel dir>"`, which is what is resolved here.) Reads
 *    through a variable cannot be seen statically; the stub-model run covers those.
 * 2. startStubModel: a local OpenAI-compatible server. Its first real turn asks
 *    for the deck_theme tool (a tool reached lazily, whose index file was missing
 *    from the package); every later turn records the tool result and ends. This
 *    lets `8gent run` get past "No Ollama models available" and run a tool.
 */
import { resolve } from "node:path";

export interface AssetRead {
	kind: "url" | "dirname";
	/** Absolute path the bundle will read when run from `distDir`. */
	target: string;
	snippet: string;
}

const DIR_DEF = /var __dirname = \(import\.meta\.dir \+ "([^"]*)"\)/g;
const DIRNAME_READ = /(?:join|resolve)\(\s*__dirname\s*,\s*"([^"]+)"/g;
const URL_READ = /new URL\(\s*"([^"]+)"\s*,\s*import\.meta\.url\s*\)/g;

export function findAssetReads(src: string, distDir: string): AssetRead[] {
	const defs: { at: number; dir: string }[] = [];
	for (const m of src.matchAll(DIR_DEF)) defs.push({ at: m.index ?? 0, dir: m[1] });
	const reads: AssetRead[] = [];
	for (const m of src.matchAll(DIRNAME_READ)) {
		const at = m.index ?? 0;
		const def = [...defs].reverse().find((d) => d.at < at);
		if (!def) continue;
		reads.push({
			kind: "dirname",
			target: resolve(distDir + def.dir, m[1]),
			snippet: m[0],
		});
	}
	for (const m of src.matchAll(URL_READ)) {
		reads.push({ kind: "url", target: resolve(distDir, m[1]), snippet: m[0] });
	}
	return reads;
}

export function missingAssetReads(
	src: string,
	distDir: string,
	exists: (p: string) => boolean,
): AssetRead[] {
	return findAssetReads(src, distDir).filter((r) => !exists(r.target));
}

export interface StubModel {
	port: number;
	/** Content of the message that followed each tool call the stub asked for. */
	toolResults: string[];
	stop(): void;
}

export function startStubModel(): StubModel {
	const toolResults: string[] = [];
	let asked = false;
	const reply = (content: string) =>
		Response.json({
			id: "stub",
			object: "chat.completion",
			model: "stub:1b",
			choices: [{ index: 0, finish_reason: "stop", message: { role: "assistant", content } }],
			usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
		});
	const server = Bun.serve({
		port: 0,
		hostname: "127.0.0.1",
		async fetch(req) {
			const url = new URL(req.url);
			if (url.pathname.endsWith("/api/tags") || url.pathname.endsWith("/models")) {
				return Response.json({ models: [{ name: "stub:1b" }], data: [{ id: "stub:1b" }] });
			}
			let body: { messages?: { role: string; content: unknown }[]; tools?: unknown[] } = {};
			try {
				body = await req.json();
			} catch {}
			const msgs = body.messages ?? [];
			// The harness probes tool support with a one-word "ping" first.
			if (msgs.length === 1 && String(msgs[0].content) === "ping") return reply("pong");
			if (!asked) {
				asked = true;
				return reply('```tool_call\n{"name": "deck_theme", "arguments": {"action": "list"}}\n```');
			}
			toolResults.push(String(msgs[msgs.length - 1]?.content ?? ""));
			return reply("hello from stub");
		},
	});
	return { port: server.port ?? 0, toolResults, stop: () => server.stop(true) };
}
