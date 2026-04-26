/**
 * DiscordGateway - Raw WebSocket client for Discord Gateway v10.
 *
 * One instance per bot token. Handles HELLO, IDENTIFY, heartbeat,
 * reconnect, resume. Emits parsed DiscordMessage on MESSAGE_CREATE.
 * No LLM calls, no response posting - deterministic only.
 */

import type { DiscordMessage } from "./types";

const GATEWAY_URL = "wss://gateway.discord.gg/?v=10&encoding=json";
// Intents: GUILDS (1) + GUILD_MESSAGES (512) + MESSAGE_CONTENT (32768)
const INTENTS = 1 | 512 | 32768;

export type MessageHandler = (message: DiscordMessage) => void;
export type ReadyHandler = (botUserId: string) => void;

export class DiscordGateway {
	private token: string;
	private label: string;
	private onMessage: MessageHandler;
	private onReady: ReadyHandler | null;

	private ws: WebSocket | null = null;
	private heartbeatTimer: ReturnType<typeof setInterval> | null = null;
	private lastSequence: number | null = null;
	private sessionId = "";
	private resumeUrl = "";
	private botUserId = "";
	private destroyed = false;

	constructor(token: string, label: string, onMessage: MessageHandler, onReady?: ReadyHandler) {
		this.token = token;
		this.label = label;
		this.onMessage = onMessage;
		this.onReady = onReady ?? null;
	}

	connect(): void {
		if (this.destroyed) return;
		const url = this.resumeUrl || GATEWAY_URL;
		console.log(`[discord:${this.label}] connecting...`);
		this.ws = new WebSocket(url);

		this.ws.addEventListener("open", () => {
			console.log(`[discord:${this.label}] connected`);
		});

		this.ws.addEventListener("message", (event) => {
			try {
				const data = JSON.parse(String(event.data));
				this.handlePayload(data);
			} catch (err) {
				console.error(`[discord:${this.label}] parse error:`, err);
			}
		});

		this.ws.addEventListener("close", (event) => {
			console.log(`[discord:${this.label}] closed: ${event.code}`);
			this.clearHeartbeat();
			if (this.destroyed) return;
			// 4004 = invalid token, do not reconnect
			if (event.code === 4004) {
				console.error(`[discord:${this.label}] invalid token - stopping`);
				return;
			}
			setTimeout(() => this.connect(), 5000);
		});

		this.ws.addEventListener("error", (err) => {
			console.error(`[discord:${this.label}] error:`, err);
		});
	}

	destroy(): void {
		this.destroyed = true;
		this.clearHeartbeat();
		if (this.ws) {
			this.ws.close(1000, "shutdown");
			this.ws = null;
		}
	}

	get userId(): string {
		return this.botUserId;
	}

	private send(payload: unknown): void {
		if (this.ws?.readyState === WebSocket.OPEN) {
			this.ws.send(JSON.stringify(payload));
		}
	}

	private clearHeartbeat(): void {
		if (this.heartbeatTimer) {
			clearInterval(this.heartbeatTimer);
			this.heartbeatTimer = null;
		}
	}

	private handlePayload(data: any): void {
		const { op, t, s, d } = data;
		if (s != null) this.lastSequence = s;

		switch (op) {
			case 10: {
				// HELLO - start heartbeat, identify or resume
				const interval = d.heartbeat_interval;
				this.clearHeartbeat();
				setTimeout(() => this.send({ op: 1, d: this.lastSequence }), Math.random() * interval);
				this.heartbeatTimer = setInterval(
					() => this.send({ op: 1, d: this.lastSequence }),
					interval,
				);
				if (this.sessionId) {
					this.send({
						op: 6,
						d: {
							token: this.token,
							session_id: this.sessionId,
							seq: this.lastSequence,
						},
					});
				} else {
					this.send({
						op: 2,
						d: {
							token: this.token,
							intents: INTENTS,
							properties: {
								os: "linux",
								browser: "8gent-board-plane",
								device: "8gent-board-plane",
							},
						},
					});
				}
				break;
			}
			case 11:
				break; // HEARTBEAT_ACK
			case 1:
				this.send({ op: 1, d: this.lastSequence });
				break; // Server heartbeat request
			case 7: {
				// RECONNECT
				console.log(`[discord:${this.label}] reconnect requested`);
				this.ws?.close(4000, "reconnect");
				break;
			}
			case 9: {
				// INVALID SESSION
				console.log(`[discord:${this.label}] invalid session, re-identifying`);
				this.sessionId = "";
				this.lastSequence = null;
				setTimeout(
					() =>
						this.send({
							op: 2,
							d: {
								token: this.token,
								intents: INTENTS,
								properties: {
									os: "linux",
									browser: "8gent-board-plane",
									device: "8gent-board-plane",
								},
							},
						}),
					2000,
				);
				break;
			}
			case 0:
				this.handleDispatch(t, d);
				break;
		}
	}

	private handleDispatch(event: string, data: any): void {
		switch (event) {
			case "READY": {
				this.sessionId = data.session_id;
				this.resumeUrl = data.resume_gateway_url;
				this.botUserId = data.user.id;
				console.log(`[discord:${this.label}] ready as ${data.user.username} (${this.botUserId})`);
				this.onReady?.(this.botUserId);
				break;
			}
			case "RESUMED": {
				console.log(`[discord:${this.label}] session resumed`);
				break;
			}
			case "MESSAGE_CREATE": {
				const msg: DiscordMessage = {
					id: data.id,
					channelId: data.channel_id,
					guildId: data.guild_id ?? null,
					author: {
						id: data.author.id,
						username: data.author.username,
						bot: data.author.bot,
					},
					mentions: (data.mentions ?? []).map((m: any) => ({ id: m.id })),
					content: data.content ?? "",
					timestamp: data.timestamp,
				};
				this.onMessage(msg);
				break;
			}
		}
	}
}
