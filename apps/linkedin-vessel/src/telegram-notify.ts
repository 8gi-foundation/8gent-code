/**
 * Telegram Notifications - Text + voice coordination layer.
 *
 * Every significant LinkedIn decision pings James on Telegram.
 * Text for detail, voice for quick awareness.
 * Uses ElevenLabs for voice if available, silent fallback if not.
 */

const TELEGRAM_API = "https://api.telegram.org/bot";
const BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN!;
const CHAT_ID = process.env.JAMES_TELEGRAM_CHAT_ID!;
const ELEVENLABS_KEY = process.env.ELEVENLABS_API_KEY;
const ELEVENLABS_VOICE_ID = process.env.ELEVENLABS_VOICE_ID || "EXAVITQu4vr4xnSDxMaL"; // default: Bella

// ── Text ──────────────────────────────────────────────────────────────

export async function tgText(text: string, silent = false): Promise<void> {
	if (!BOT_TOKEN || !CHAT_ID) return;

	try {
		await fetch(`${TELEGRAM_API}${BOT_TOKEN}/sendMessage`, {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({
				chat_id: CHAT_ID,
				text,
				parse_mode: "Markdown",
				disable_notification: silent,
			}),
		});
	} catch (e: any) {
		console.error("[telegram] send failed:", e.message);
	}
}

// ── Voice ─────────────────────────────────────────────────────────────

async function generateAudio(text: string): Promise<ArrayBuffer | null> {
	if (!ELEVENLABS_KEY) return null;

	try {
		const res = await fetch(`https://api.elevenlabs.io/v1/text-to-speech/${ELEVENLABS_VOICE_ID}`, {
			method: "POST",
			headers: {
				"xi-api-key": ELEVENLABS_KEY,
				"content-type": "application/json",
			},
			body: JSON.stringify({
				text,
				model_id: "eleven_turbo_v2",
				voice_settings: { stability: 0.5, similarity_boost: 0.75 },
			}),
		});
		if (!res.ok) return null;
		return res.arrayBuffer();
	} catch {
		return null;
	}
}

export async function tgVoice(text: string): Promise<void> {
	if (!BOT_TOKEN || !CHAT_ID) return;

	const audio = await generateAudio(text);
	if (!audio) {
		// Fallback to text if ElevenLabs not available
		await tgText(`_[voice]_ ${text}`);
		return;
	}

	try {
		const formData = new FormData();
		formData.append("chat_id", CHAT_ID);
		formData.append("voice", new Blob([audio], { type: "audio/mpeg" }), "message.mp3");

		await fetch(`${TELEGRAM_API}${BOT_TOKEN}/sendVoice`, {
			method: "POST",
			body: formData,
		});
	} catch (e: any) {
		console.error("[telegram] voice send failed:", e.message);
	}
}

// ── Combined (text + voice) ───────────────────────────────────────────

export async function tgUpdate(textMessage: string, voiceSummary: string): Promise<void> {
	// Send text first (immediate), then voice
	await tgText(textMessage);
	await tgVoice(voiceSummary);
}

// ── Event notifications ───────────────────────────────────────────────

export async function notifyLeadsFound(count: number, criteria: string): Promise<void> {
	await tgUpdate(
		`*LinkedIn - Leads Found*\n\n${count} leads matching: _${criteria}_\n\nReady to enrich and build outreach sequence. Reply here or go to claude.ai to review.`,
		`Found ${count} LinkedIn leads for ${criteria}. Ready for your review.`,
	);
}

export async function notifyMessageSent(
	name: string,
	company: string,
	touchStep: number,
): Promise<void> {
	await tgText(
		`*LinkedIn - Message Sent*\nTouch ${touchStep} to ${name} at ${company}`,
		true, // silent - don't buzz for every send
	);
}

export async function notifyReplyReceived(senderName: string, preview: string): Promise<void> {
	await tgUpdate(
		`*LinkedIn - Reply Received*\n\n*From:* ${senderName}\n*Preview:* "${preview.slice(0, 150)}"\n\nRespond via claude.ai with the 8GI LinkedIn connector.`,
		`${senderName} replied on LinkedIn. Check it out.`,
	);
}

export async function notifyHyperAgentEvolution(evolved: number, details: string[]): Promise<void> {
	if (evolved === 0) return;

	await tgUpdate(
		`*LinkedIn - HyperAgent Evolution*\n\n${evolved} template(s) rewritten based on reply rate data:\n\n${details.map((d) => `- ${d}`).join("\n")}`,
		`HyperAgent evolved ${evolved} LinkedIn message templates. The system just got smarter.`,
	);
}

export async function notifyDailySummary(stats: {
	sent: number;
	replies: number;
	replyRate: number;
	qualified: number;
	budgetRemaining: Record<string, number>;
}): Promise<void> {
	const lines = [
		"*LinkedIn Daily Summary*",
		"",
		`Sent: ${stats.sent}`,
		`Replies: ${stats.replies} (${(stats.replyRate * 100).toFixed(1)}%)`,
		`Qualified: ${stats.qualified}`,
		"",
		"*Budget remaining today:*",
		`- Connection requests: ${stats.budgetRemaining.connection_requests}`,
		`- Messages: ${stats.budgetRemaining.messages}`,
	];

	await tgUpdate(
		lines.join("\n"),
		`LinkedIn daily summary: ${stats.sent} sent, ${stats.replies} replies, ${stats.qualified} qualified.`,
	);
}
