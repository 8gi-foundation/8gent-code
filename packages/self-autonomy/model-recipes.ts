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

/** The file API keys go in, as people read it on screen. */
export const KEYS_FILE_DISPLAY = "~/.8gent/keys.env";
