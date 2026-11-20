/**
 * One recommended model per local server, and one key file, named the same
 * on every first-run screen (#4220). Before this the NO MODEL card, the
 * provider check and the docs each named a different model, a different
 * Ollama domain and a different key file.
 *
 * - Ollama: `qwen3.5` is the Ollama provider's default model
 *   (packages/providers/index.ts, `qwen3.5:latest`) and what docs/install/*.md
 *   pull. Its registry manifest (latest = 9b) is 6.55 GB, checked 13 Oct 2026.
 * - LM Studio: `google/gemma-4-26b-a4b` is the LM Studio provider's default
 *   model. Its Q4_K_M GGUF is 16.8 GB, checked 13 Oct 2026.
 * - Keys: `~/.8gent/keys.env`, the file `8gent keys` opens and bin/8gent.ts
 *   loads at launch, as the install guides say.
 */

export const OLLAMA_RECOMMENDED = {
	pull: "qwen3.5",
	size: "about 7 GB",
	site: "https://ollama.com/download",
} as const;

export const LMSTUDIO_RECOMMENDED = {
	model: "google/gemma-4-26b-a4b",
	size: "about 17 GB",
	site: "https://lmstudio.ai",
} as const;

/**
 * A phone (Android, Termux): llama.cpp, not Ollama. `pkg install llama-cpp` ships
 * llama-server (termux-packages, packages/llama-cpp, checked 7 Nov 2026). `-hf` fetches
 * the GGUF from Hugging Face on first start and serves it on 127.0.0.1:8080, the
 * llama-server provider's default address. ggml-org/gemma-3-1b-it-GGUF picks its Q4_K_M
 * file by default, 806 MB (Hugging Face tree API, checked 7 Nov 2026). Each line is a
 * whole command, so it is never a bare model name in code.
 */
export const PHONE_LLAMA_RECOMMENDED = {
	// local-first-gate: optin shown only on the phone's NO MODEL card as a command the person may type; nothing runs it
	install: "pkg install llama-cpp",
	serve: "llama-server -hf ggml-org/gemma-3-1b-it-GGUF",
	size: "about 0.8 GB download",
} as const;

/** The file API keys go in, as people read it on screen. */
export const KEYS_FILE_DISPLAY = "~/.8gent/keys.env";
