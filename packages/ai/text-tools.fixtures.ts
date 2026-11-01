/**
 * Recorded model replies used by the text-tools tests.
 *
 * LLAMA32_BARE_JSON_REPLY is the exact modelOutput.content of the Engineer tab
 * turn in rishi-pilot run 2026-09-29_195825/l2-split-deck (ollama llama3.2:3b,
 * home/.8gent/turns/session_1790708530684_m6m4yt/0.json). Both calls were shown
 * to the user as text and never ran. Note the stray ``` after the first call
 * and the raw newlines inside the write_file content string.
 */
export const LLAMA32_BARE_JSON_REPLY =
	"{\"name\": \"get_outline\", \"arguments\": {\"path\": \"deck/outline.md\"}}\n```\n\n{\"name\": \"write_file\", \"arguments\": {\"path\": \"/home/user/project/deck/deck.md\", \"content\": \"---\nmarp: true\n\n## [Planning]\n1. Read deck/outline.md and turn it into deck/deck.md in Marp style\n---\n\n\n## [Design]\n1. Design a deck in Marp style\n\n---\n\n\n## [Implementation]\n1. Implement Marp deck design\n\n---\n\n\n## [Testing]\n1. Test the deck for usability\n\n---\n\n\n## [Deployment]\n1. Deploy the deck to production\n\n---\n\n\n## [Maintenance]\n1. Maintain the deck for future updates\n\n---\"}}";
