/**
 * 8Gent Bot - Telegram orchestrator
 *
 * The single always-on entry point for all officer vessels.
 * Receives messages, routes to correct officer, streams response back.
 *
 * Bot: @8gent_bot
 * Always-on: min_machines=1
 */

import { routeMessage } from "./router";
import { invokeVessel } from "./vessel-client";

const BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN!;
const JAMES_CHAT_ID = process.env.JAMES_TELEGRAM_CHAT_ID!;
const PORT = Number.parseInt(process.env.PORT ?? "8080");

const TG_API = `https://api.telegram.org/bot${BOT_TOKEN}`;

// ── Telegram helpers ──────────────────────────────────────────────────────

async function sendMessage(
	chat_id: number | string,
	text: string,
	parse_mode: "Markdown" | "HTML" | "None" = "Markdown",
): Promise<void> {
	const body: Record<string, unknown> = { chat_id, text };
	if (parse_mode !== "None") body.parse_mode = parse_mode;

	await fetch(`${TG_API}/sendMessage`, {
		method: "POST",
		headers: { "content-type": "application/json" },
		body: JSON.stringify(body),
	});
}

async function sendTyping(chat_id: number | string): Promise<void> {
	await fetch(`${TG_API}/sendChatAction`, {
		method: "POST",
		headers: { "content-type": "application/json" },
		body: JSON.stringify({ chat_id, action: "typing" }),
	});
}

async function setWebhook(): Promise<void> {
	const public_url = process.env.PUBLIC_URL;
	if (!public_url) {
		console.log("[bot] No PUBLIC_URL set - skipping webhook registration");
		return;
	}

	const webhookUrl = `${public_url}/webhook`;
	const res = await fetch(`${TG_API}/setWebhook`, {
		method: "POST",
		headers: { "content-type": "application/json" },
		body: JSON.stringify({ url: webhookUrl, drop_pending_updates: false }),
	});
	const data = (await res.json()) as { ok: boolean; description?: string };
	if (data.ok) {
		console.log(`[bot] Webhook set: ${webhookUrl}`);
	} else {
		console.error("[bot] Webhook set failed:", data.description);
	}
}

// ── Message handler ───────────────────────────────────────────────────────

async function handleUpdate(update: TelegramUpdate): Promise<void> {
	const msg = update.message ?? update.edited_message;
	if (!msg) return;

	const chatId = msg.chat.id;
	const text = msg.text ?? msg.caption ?? "";

	// Only respond to James
	if (String(chatId) !== String(JAMES_CHAT_ID)) {
		console.log(`[bot] Ignoring message from unknown chat ${chatId}`);
		return;
	}

	if (!text.trim()) return;

	// Route the message
	const route = routeMessage(text);
	const officerTag = route.matched_keyword
		? `_[routing to ${route.name} via "${route.matched_keyword}"]_`
		: `_[routing to ${route.name}]_`;

	await sendTyping(chatId);
	await sendMessage(chatId, officerTag);

	// Wake + invoke the vessel
	const result = await invokeVessel(route.fly_app, {
		task: text,
		from: "james_telegram",
	});

	const latencyNote =
		result.latency_ms > 5000 ? ` _(${(result.latency_ms / 1000).toFixed(1)}s)_` : "";

	const response = `*${route.name} (${route.code}):*\n\n${result.response}${latencyNote}`;
	await sendMessage(chatId, response);
}

// ── Webhook server ────────────────────────────────────────────────────────

interface TelegramUpdate {
	update_id: number;
	message?: {
		chat: { id: number };
		text?: string;
		caption?: string;
		from?: { id: number; username?: string };
	};
	edited_message?: {
		chat: { id: number };
		text?: string;
		caption?: string;
	};
}

const server = Bun.serve({
	port: PORT,

	async fetch(req) {
		const url = new URL(req.url);

		if (url.pathname === "/health" && req.method === "GET") {
			return Response.json({ status: "ok", bot: "@8gent_bot", ts: Date.now() });
		}

		if (url.pathname === "/webhook" && req.method === "POST") {
			const update = (await req.json()) as TelegramUpdate;
			// Handle async - don't block the 200 response
			handleUpdate(update).catch((err) => console.error("[bot] handleUpdate error:", err));
			return new Response("ok");
		}

		return new Response("Not Found", { status: 404 });
	},
});

console.log(`[bot] 8Gent orchestrator running on :${PORT}`);

// Register webhook on startup
setWebhook().catch(console.error);

process.on("SIGTERM", () => {
	console.log("[bot] SIGTERM - shutting down");
	server.stop();
	process.exit(0);
});
