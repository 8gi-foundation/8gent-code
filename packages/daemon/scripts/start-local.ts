#!/usr/bin/env bun
/**
 * Canonical launcher for the local-mode daemon.
 *
 * Usage:
 *   bun run packages/daemon/scripts/start-local.ts
 *   bun run daemon:local           (via package.json script)
 *
 * Sets EIGHT_DAEMON_LOCAL=1 + DAEMON_HOSTNAME=127.0.0.1 before importing
 * the daemon main, so the gateway binds to loopback from the very first
 * Bun.serve() call.
 *
 * Env vars consumed downstream (see packages/daemon/index.ts header):
 *   - TELEGRAM_BOT_TOKEN
 *   - TELEGRAM_AUTHORIZED_CHAT_IDS
 *   - EIGHT_TELEGRAM_LOCAL=1   (opt-in to the local Telegram bridge)
 *   - EIGHT_VOICE_OUT_LOCAL=1  (opt-in to KittenTTS voice-out for telegram)
 *   - EIGHT_VOICE_OUT_VOICE    (override default expr-voice-2-m voice)
 *   - GROQ_API_KEY  or  OPENAI_API_KEY  (required for voice-in
 *                                          transcription; Groq preferred)
 */

process.env.EIGHT_DAEMON_LOCAL = "1";
if (!process.env.DAEMON_HOSTNAME) {
	process.env.DAEMON_HOSTNAME = "127.0.0.1";
}

import { main } from "../index";

main().catch((err) => {
	console.error("[daemon-local] fatal:", err);
	process.exit(1);
});
