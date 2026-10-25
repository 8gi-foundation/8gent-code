/**
 * Wording for "the local runtime is not up". It never tells a person to install
 * anything on the system. It names the llama.cpp server provider, which exists
 * (/provider llama-server, LLAMA_SERVER_URL) and does not need Ollama. The Ollama
 * client and its fallback are untouched; this is text only (#4915, epic #4939).
 */

/** What to try in the 8gent TUI: the llama.cpp server provider, no install step. */
export const LLAMA_SERVER_HINT =
	"In the 8gent TUI, run /provider llama-server to use a local llama.cpp server (127.0.0.1:8080, or set LLAMA_SERVER_URL)";

/** `8gent run` when the local runtime does not answer. */
export const LOCAL_RUNTIME_UNREACHABLE = `Local runtime not reachable. ${LLAMA_SERVER_HINT}, or set a provider via \`8gent run --provider openrouter ...\`.`;

/** REPL start-up warning when the local runtime does not answer. */
export const REPL_RUNTIME_DOWN_LINES = [
	"⚠️  The local runtime is not running.",
	`   ${LLAMA_SERVER_HINT}.`,
	"   Then run: npx 8gent-code",
] as const;
