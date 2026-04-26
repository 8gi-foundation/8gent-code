/**
 * Board Vessel Daemon - Autonomous Discord bot for 8GI board members.
 *
 * Connects to Discord Gateway via raw WebSocket, listens for messages,
 * generates responses via local Ollama, posts back. No heavy deps.
 */

// -- Config from env --
const DISCORD_TOKEN = process.env.DISCORD_BOT_TOKEN ?? "";
const MEMBER_CODE = process.env.BOARD_MEMBER_CODE ?? "8TO";
const MEMBER_NAME = process.env.BOARD_MEMBER_NAME ?? "Rishi";
const MEMBER_ROLE = process.env.BOARD_MEMBER_ROLE ?? "8gent Technology Officer";
const OLLAMA_MODEL = process.env.OLLAMA_MODEL ?? "qwen3:latest";
const OLLAMA_HOST = process.env.OLLAMA_HOST ?? "http://localhost:11434";

if (!DISCORD_TOKEN) {
	console.error("[board-vessel] DISCORD_BOT_TOKEN is required");
	process.exit(1);
}

// -- System prompts per board member --
const SYSTEM_PROMPTS: Record<string, string> = {
	"8EO": `You are Daniel, the 8gent Executive Officer (8EO). You chair board meetings, coordinate across all officers, and make final strategic decisions. You speak with calm authority. Keep responses concise and actionable. When reviewing proposals, always ask: does this serve the 8gent Constitution? You are pragmatic, not performative.`,
	"8TO": `You are Rishi, the 8gent Technology Officer (8TO). You own technical architecture, code quality, testing, and infrastructure. You review PRs, flag complexity debt, and enforce engineering standards. You are direct, evidence-driven, and allergic to hype. When evaluating technical proposals, ask: what breaks, what scales, what ships.`,
	"8PO": `You are Samantha, the 8gent Product Officer (8PO). You advocate for users, manage scope, and prioritize the roadmap. You push back on feature creep and always ask: who is this for, what problem does it solve, how do we measure success? You are empathetic but firm on priorities.`,
	"8DO": `You are Moira, the 8gent Design Officer (8DO). You own visual quality, brand consistency, accessibility, and user experience. You review all customer-facing artifacts for design standards. You have strong opinions on typography, spacing, and color. No purple. No em dashes. You are precise and tasteful.`,
	"8SO": `You are Karen, the 8gent Security Officer (8SO). You review all code and infrastructure for security vulnerabilities, enforce the security framework, and model threats. You are thorough, cautious, and never assume something is safe without evidence. You flag risks clearly and propose mitigations.`,
};

const systemPrompt = SYSTEM_PROMPTS[MEMBER_CODE] ?? SYSTEM_PROMPTS["8TO"];

// -- Rate limiting --
let lastResponseTime = 0;
const RATE_LIMIT_MS = 10_000;

// -- Health tracking --
const startTime = Date.now();
let botUserId = "";

// -- Health check HTTP server --
Bun.serve({
	port: 8080,
	hostname: "0.0.0.0",
	fetch(_req) {
		const url = new URL(_req.url);
		if (url.pathname === "/health" || url.pathname === "/") {
			return Response.json({
				status: "ok",
				member: MEMBER_CODE,
				name: MEMBER_NAME,
				role: MEMBER_ROLE,
				uptime: Math.floor((Date.now() - startTime) / 1000),
			});
		}
		return new Response("Board Vessel - " + MEMBER_CODE, { status: 200 });
	},
});
console.log(`[board-vessel] Health check listening on :8080`);

// -- Discord Gateway --
const DISCORD_API = "https://discord.com/api/v10";
const GATEWAY_URL = "wss://gateway.discord.gg/?v=10&encoding=json";

// Intents: GUILDS (1) + GUILD_MESSAGES (512) + MESSAGE_CONTENT (32768)
const INTENTS = 1 | 512 | 32768;

let heartbeatInterval: ReturnType<typeof setInterval> | null = null;
let lastSequence: number | null = null;
let ws: WebSocket | null = null;
let sessionId = "";
let resumeUrl = "";

function connectGateway(): void {
	const url = resumeUrl || GATEWAY_URL;
	console.log(`[board-vessel] Connecting to Discord Gateway...`);
	ws = new WebSocket(url);

	ws.addEventListener("open", () => {
		console.log(`[board-vessel] WebSocket connected`);
	});

	ws.addEventListener("message", (event) => {
		const data = JSON.parse(String(event.data));
		handleGatewayMessage(data);
	});

	ws.addEventListener("close", (event) => {
		console.log(
			`[board-vessel] WebSocket closed: ${event.code} ${event.reason}`,
		);
		if (heartbeatInterval) clearInterval(heartbeatInterval);
		heartbeatInterval = null;

		// Reconnect after 5s (unless code 4004 = invalid token)
		if (event.code === 4004) {
			console.error("[board-vessel] Invalid token - not reconnecting");
			process.exit(1);
		}
		setTimeout(connectGateway, 5000);
	});

	ws.addEventListener("error", (err) => {
		console.error("[board-vessel] WebSocket error:", err);
	});
}

function sendGateway(payload: unknown): void {
	if (ws?.readyState === WebSocket.OPEN) {
		ws.send(JSON.stringify(payload));
	}
}

function sendHeartbeat(): void {
	sendGateway({ op: 1, d: lastSequence });
}

function sendIdentify(): void {
	sendGateway({
		op: 2,
		d: {
			token: DISCORD_TOKEN,
			intents: INTENTS,
			properties: {
				os: "linux",
				browser: "8gent-board-vessel",
				device: "8gent-board-vessel",
			},
		},
	});
}

function sendResume(): void {
	sendGateway({
		op: 6,
		d: {
			token: DISCORD_TOKEN,
			session_id: sessionId,
			seq: lastSequence,
		},
	});
}

function handleGatewayMessage(data: any): void {
	const { op, t, s, d } = data;

	// Track sequence number
	if (s !== null && s !== undefined) lastSequence = s;

	switch (op) {
		case 10: {
			// HELLO - start heartbeating and identify
			const interval = d.heartbeat_interval;
			console.log(`[board-vessel] HELLO - heartbeat every ${interval}ms`);

			if (heartbeatInterval) clearInterval(heartbeatInterval);

			// Send first heartbeat after jitter
			setTimeout(sendHeartbeat, Math.random() * interval);
			heartbeatInterval = setInterval(sendHeartbeat, interval);

			// Identify or resume
			if (sessionId) {
				sendResume();
			} else {
				sendIdentify();
			}
			break;
		}
		case 11: {
			// HEARTBEAT_ACK - all good
			break;
		}
		case 1: {
			// Server requests heartbeat
			sendHeartbeat();
			break;
		}
		case 7: {
			// RECONNECT - server wants us to reconnect
			console.log("[board-vessel] Server requested reconnect");
			ws?.close(4000, "reconnect requested");
			break;
		}
		case 9: {
			// INVALID SESSION - re-identify
			console.log("[board-vessel] Invalid session, re-identifying");
			sessionId = "";
			lastSequence = null;
			setTimeout(sendIdentify, 2000);
			break;
		}
		case 0: {
			// DISPATCH - handle events
			handleDispatch(t, d);
			break;
		}
	}
}

function handleDispatch(eventName: string, data: any): void {
	switch (eventName) {
		case "READY": {
			sessionId = data.session_id;
			resumeUrl = data.resume_gateway_url;
			botUserId = data.user.id;
			console.log(
				`[board-vessel] READY as ${data.user.username}#${data.user.discriminator} (${botUserId})`,
			);
			console.log(`[board-vessel] ${MEMBER_NAME} (${MEMBER_CODE}) is online`);
			break;
		}
		case "RESUMED": {
			console.log("[board-vessel] Session resumed");
			break;
		}
		case "MESSAGE_CREATE": {
			handleMessage(data);
			break;
		}
	}
}

async function handleMessage(msg: any): Promise<void> {
	// Ignore own messages
	if (msg.author.id === botUserId) return;
	// Ignore bot messages
	if (msg.author.bot) return;

	// Check if the bot was mentioned or message is a DM (guild_id absent)
	const isMentioned = msg.mentions?.some((m: any) => m.id === botUserId);
	const isDM = !msg.guild_id;

	if (!isMentioned && !isDM) return;

	// Rate limit
	const now = Date.now();
	if (now - lastResponseTime < RATE_LIMIT_MS) {
		console.log("[board-vessel] Rate limited, skipping");
		return;
	}
	lastResponseTime = now;

	// Strip the mention from content
	const content = msg.content.replace(/<@!?\d+>/g, "").trim();
	if (!content) return;

	console.log(
		`[board-vessel] Message from ${msg.author.username}: ${content.slice(0, 80)}`,
	);

	try {
		const response = await generateResponse(content);
		await sendDiscordMessage(msg.channel_id, response);
	} catch (err) {
		console.error("[board-vessel] Error generating response:", err);
		await sendDiscordMessage(
			msg.channel_id,
			`[${MEMBER_CODE}] I hit an error processing that. Check vessel logs.`,
		);
	}
}

async function generateResponse(userMessage: string): Promise<string> {
	const res = await fetch(`${OLLAMA_HOST}/api/chat`, {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify({
			model: OLLAMA_MODEL,
			messages: [
				{ role: "system", content: systemPrompt },
				{ role: "user", content: userMessage },
			],
			stream: false,
			options: { num_predict: 500 },
		}),
	});

	if (!res.ok) {
		throw new Error(`Ollama returned ${res.status}: ${await res.text()}`);
	}

	const data = await res.json();
	let reply: string = data.message?.content ?? "No response generated.";

	// Discord message limit is 2000 chars
	if (reply.length > 1900) {
		reply = reply.slice(0, 1900) + "...";
	}

	return reply;
}

async function sendDiscordMessage(
	channelId: string,
	content: string,
): Promise<void> {
	const res = await fetch(`${DISCORD_API}/channels/${channelId}/messages`, {
		method: "POST",
		headers: {
			Authorization: `Bot ${DISCORD_TOKEN}`,
			"Content-Type": "application/json",
		},
		body: JSON.stringify({ content }),
	});

	if (!res.ok) {
		console.error(
			`[board-vessel] Discord API error: ${res.status} ${await res.text()}`,
		);
	}
}

// -- Start --
console.log(`[board-vessel] ${MEMBER_NAME} (${MEMBER_CODE}) - ${MEMBER_ROLE}`);
console.log(`[board-vessel] Model: ${OLLAMA_MODEL}`);
connectGateway();
