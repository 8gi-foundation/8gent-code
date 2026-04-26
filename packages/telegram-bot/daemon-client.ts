/**
 * @8gent/telegram-bot - Daemon Client
 *
 * Thin WebSocket wrapper around the daemon Gateway protocol. Handles auth,
 * session create/resume, prompt dispatch, and event subscription with
 * automatic reconnect.
 *
 * Used by the production telegram-bridge to drive multi-step tasks against
 * the AgentPool. Stand-alone tests can swap the underlying socket for a
 * fake implementation by passing `socketFactory`.
 */

export type DaemonEventName =
	| "tool:start"
	| "tool:result"
	| "agent:thinking"
	| "agent:stream"
	| "agent:error"
	| "memory:saved"
	| "approval:required"
	| "session:start"
	| "session:end";

export interface DaemonEvent<P = unknown> {
	event: DaemonEventName;
	payload: P;
}

export interface DaemonClientConfig {
	url: string;
	authToken?: string;
	channel?: string;
	reconnectDelayMs?: number;
	pingIntervalMs?: number;
	socketFactory?: (url: string) => WebSocketLike;
}

export interface WebSocketLike {
	readyState: number;
	send(data: string): void;
	close(): void;
	onopen: ((ev?: unknown) => void) | null;
	onclose: ((ev?: unknown) => void) | null;
	onerror: ((ev?: unknown) => void) | null;
	onmessage: ((ev: { data: string | ArrayBuffer }) => void) | null;
}

const OPEN = 1;

type Listener<E extends DaemonEventName> = (payload: EventPayloads[E]) => void;

export interface EventPayloads {
	"tool:start": { sessionId: string; tool: string; input: unknown };
	"tool:result": { sessionId: string; tool: string; output: unknown; durationMs: number };
	"agent:thinking": { sessionId: string };
	"agent:stream": { sessionId: string; chunk: string; final?: boolean };
	"agent:error": { sessionId: string; error: string };
	"memory:saved": { sessionId: string; key: string };
	"approval:required": { sessionId: string; tool: string; input: unknown; requestId: string };
	"session:start": { sessionId: string; channel: string };
	"session:end": { sessionId: string; reason: string };
}

export class DaemonClient {
	private config: Required<
		Pick<DaemonClientConfig, "url" | "channel" | "reconnectDelayMs" | "pingIntervalMs">
	> &
		DaemonClientConfig;
	private ws: WebSocketLike | null = null;
	private sessionId: string | null = null;
	private pingTimer: ReturnType<typeof setInterval> | null = null;
	private listeners = new Map<DaemonEventName, Set<Listener<DaemonEventName>>>();
	private connectResolvers: Array<() => void> = [];
	private connectRejectors: Array<(err: Error) => void> = [];
	private connecting = false;
	private closed = false;

	constructor(config: DaemonClientConfig) {
		this.config = {
			url: config.url,
			authToken: config.authToken,
			channel: config.channel ?? "telegram",
			reconnectDelayMs: config.reconnectDelayMs ?? 5000,
			pingIntervalMs: config.pingIntervalMs ?? 10 * 60 * 1000,
			socketFactory: config.socketFactory,
		};
	}

	/** Open the WebSocket and create a session. Resolves once session:created arrives. */
	connect(): Promise<void> {
		if (this.ws && this.ws.readyState === OPEN && this.sessionId) {
			return Promise.resolve();
		}
		return new Promise<void>((resolve, reject) => {
			this.connectResolvers.push(resolve);
			this.connectRejectors.push(reject);
			if (!this.connecting) this.openSocket();
		});
	}

	private openSocket(): void {
		this.connecting = true;
		const factory = this.config.socketFactory ?? defaultSocketFactory;
		const ws = factory(this.config.url);
		this.ws = ws;

		ws.onopen = () => {
			if (this.config.authToken) {
				this.send({ type: "auth", token: this.config.authToken });
			}
			this.send({ type: "session:create", channel: this.config.channel });
		};

		ws.onmessage = (ev) => {
			const raw = typeof ev.data === "string" ? ev.data : new TextDecoder().decode(ev.data);
			let msg: { type: string; [k: string]: unknown };
			try {
				msg = JSON.parse(raw);
			} catch {
				return;
			}
			this.handleMessage(msg);
		};

		ws.onerror = () => {
			this.failConnect(new Error("daemon-client: socket error"));
		};

		ws.onclose = () => {
			this.stopPing();
			this.ws = null;
			this.sessionId = null;
			this.connecting = false;
			if (!this.closed) {
				setTimeout(() => this.openSocket(), this.config.reconnectDelayMs);
			}
		};
	}

	private handleMessage(msg: { type: string; [k: string]: unknown }): void {
		switch (msg.type) {
			case "session:created":
				this.sessionId = String(msg.sessionId);
				this.connecting = false;
				this.startPing();
				this.resolveConnect();
				break;
			case "session:resumed":
				this.sessionId = String(msg.sessionId);
				break;
			case "auth:ok":
				break;
			case "auth:fail":
				this.failConnect(new Error("daemon-client: auth failed"));
				break;
			case "event": {
				const event = msg.event as DaemonEventName;
				const payload = msg.payload as EventPayloads[DaemonEventName];
				this.dispatch(event, payload);
				break;
			}
			case "pong":
				break;
		}
	}

	/** Send a prompt to the current session. */
	sendPrompt(text: string): void {
		this.send({ type: "prompt", text });
	}

	/** Force a fresh session (e.g. on cancel / new task). */
	resetSession(): void {
		this.sessionId = null;
		this.send({ type: "session:create", channel: this.config.channel });
	}

	/** Send an approval response back to the daemon. */
	respondApproval(requestId: string, approved: boolean): void {
		this.send({ type: "approval:response", requestId, approved });
	}

	/** Subscribe to a daemon event. Returns an unsubscribe function. */
	on<E extends DaemonEventName>(event: E, handler: Listener<E>): () => void {
		let set = this.listeners.get(event);
		if (!set) {
			set = new Set();
			this.listeners.set(event, set);
		}
		set.add(handler as Listener<DaemonEventName>);
		return () => set?.delete(handler as Listener<DaemonEventName>);
	}

	getSessionId(): string | null {
		return this.sessionId;
	}

	isOpen(): boolean {
		return this.ws?.readyState === OPEN;
	}

	close(): void {
		this.closed = true;
		this.stopPing();
		this.ws?.close();
		this.ws = null;
	}

	private send(payload: object): void {
		if (this.ws && this.ws.readyState === OPEN) {
			try {
				this.ws.send(JSON.stringify(payload));
			} catch {
				// Connection dropped between readyState check and send.
			}
		}
	}

	private dispatch<E extends DaemonEventName>(event: E, payload: EventPayloads[E]): void {
		const set = this.listeners.get(event);
		if (!set) return;
		set.forEach((handler) => {
			try {
				(handler as Listener<E>)(payload);
			} catch {
				// One bad listener should not break the others.
			}
		});
	}

	private startPing(): void {
		this.stopPing();
		this.pingTimer = setInterval(() => {
			this.send({ type: "ping" });
		}, this.config.pingIntervalMs);
	}

	private stopPing(): void {
		if (this.pingTimer) {
			clearInterval(this.pingTimer);
			this.pingTimer = null;
		}
	}

	private resolveConnect(): void {
		const resolvers = this.connectResolvers.splice(0);
		this.connectRejectors.length = 0;
		for (const r of resolvers) r();
	}

	private failConnect(err: Error): void {
		const rejectors = this.connectRejectors.splice(0);
		this.connectResolvers.length = 0;
		for (const r of rejectors) r(err);
	}
}

function defaultSocketFactory(url: string): WebSocketLike {
	return new WebSocket(url) as unknown as WebSocketLike;
}
