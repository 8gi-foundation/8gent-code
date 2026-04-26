/**
 * Vessel Mesh - P2P communication between remote 8gent vessels
 *
 * Extends the local AgentMesh concept to network-aware vessel-to-vessel
 * communication. Vessels discover each other via a shared registry (Convex)
 * and communicate via WebSocket.
 *
 * Architecture:
 *   1. Register with Convex on startup (vesselId, url, capabilities)
 *   2. Discover peers via Convex query
 *   3. Open WebSocket connections for direct messaging
 *   4. Route tasks to best-fit vessel based on capabilities
 *   5. Heartbeat keeps registry fresh, stale vessels pruned
 *
 * Message format is compatible with the local MeshMessage from agent-mesh.ts
 * so local and remote messages can be processed uniformly.
 */

// MARK: - Types

export interface VesselInfo {
	id: string;
	name: string;
	url: string; // WebSocket endpoint (wss://vessel.fly.dev)
	ownerId: string; // user who owns this vessel
	capabilities: string[];
	model: string;
	region: string; // e.g. "ams" for Amsterdam
	startedAt: number;
	lastHeartbeat: number;
	activeSessions: number;
	maxSessions: number;
}

export interface VesselMessage {
	id: string;
	from: string; // vesselId
	to: string; // vesselId or "broadcast"
	type:
		| "task"
		| "result"
		| "status"
		| "capability-query"
		| "capability-response"
		| "heartbeat";
	payload: Record<string, unknown>;
	timestamp: number;
	/** Correlation ID for request/response pairs */
	correlationId?: string;
}

export interface TaskPayload {
	prompt: string;
	cwd?: string;
	model?: string;
	constraints?: string[];
	timeoutMs?: number;
	/** If true, the remote vessel streams progress back */
	stream?: boolean;
}

export interface TaskResult {
	status: "completed" | "failed" | "timeout";
	output: string;
	tokensUsed?: number;
	durationMs: number;
	error?: string;
}

// MARK: - Vessel Mesh Node

export class VesselMesh {
	private vesselInfo: VesselInfo;
	private peers: Map<string, VesselInfo> = new Map();
	private connections: Map<string, WebSocket> = new Map();
	private pendingRequests: Map<
		string,
		{
			resolve: (result: VesselMessage) => void;
			reject: (error: Error) => void;
			timer: ReturnType<typeof setTimeout>;
		}
	> = new Map();
	private heartbeatInterval?: ReturnType<typeof setInterval>;
	private discoveryInterval?: ReturnType<typeof setInterval>;
	private messageHandler?: (msg: VesselMessage) => void;
	private taskHandler?: (
		task: TaskPayload,
		from: string,
	) => Promise<TaskResult>;

	// Lazily resolved Convex client
	private _client: any = null;
	private _api: any = null;
	private _resolved = false;

	constructor(info: Omit<VesselInfo, "lastHeartbeat">) {
		this.vesselInfo = {
			...info,
			lastHeartbeat: Date.now(),
		};
	}

	// MARK: - Lifecycle

	async start(): Promise<void> {
		await this.register();
		await this.discoverPeers();
		this.startHeartbeat();
		this.startDiscovery();
	}

	async stop(): Promise<void> {
		if (this.heartbeatInterval) clearInterval(this.heartbeatInterval);
		if (this.discoveryInterval) clearInterval(this.discoveryInterval);

		// Close all WebSocket connections
		for (const [id, ws] of this.connections) {
			ws.close();
			this.connections.delete(id);
		}

		// Clear pending requests
		for (const [, req] of this.pendingRequests) {
			clearTimeout(req.timer);
			req.reject(new Error("Vessel mesh shutting down"));
		}
		this.pendingRequests.clear();

		await this.unregister();
	}

	// MARK: - Registry (Convex-backed)

	private async resolveConvex(): Promise<boolean> {
		if (this._resolved) return this._client !== null;
		try {
			const { getConvexClient } = await import("../db/client.js");
			const { api } = await import("../db/convex/_generated/api.js");
			this._client = getConvexClient();
			this._api = api;
			this._resolved = true;
			return true;
		} catch {
			this._resolved = true;
			return false;
		}
	}

	private async register(): Promise<void> {
		this.vesselInfo.lastHeartbeat = Date.now();
		if (!(await this.resolveConvex())) return;
		try {
			await this._client.mutation(this._api.vessels.register, {
				vesselId: this.vesselInfo.id,
				name: this.vesselInfo.name,
				url: this.vesselInfo.url,
				ownerId: this.vesselInfo.ownerId,
				capabilities: this.vesselInfo.capabilities,
				model: this.vesselInfo.model,
				region: this.vesselInfo.region,
				startedAt: this.vesselInfo.startedAt,
				activeSessions: this.vesselInfo.activeSessions,
				maxSessions: this.vesselInfo.maxSessions,
			});
		} catch {}
	}

	private async unregister(): Promise<void> {
		if (!(await this.resolveConvex())) return;
		try {
			await this._client.mutation(this._api.vessels.unregister, {
				vesselId: this.vesselInfo.id,
			});
		} catch {}
	}

	private async convexHeartbeat(): Promise<void> {
		if (!(await this.resolveConvex())) return;
		try {
			await this._client.mutation(this._api.vessels.heartbeat, {
				vesselId: this.vesselInfo.id,
				activeSessions: this.vesselInfo.activeSessions,
			});
		} catch {}
	}

	// MARK: - Peer Discovery

	async discoverPeers(): Promise<VesselInfo[]> {
		if (!(await this.resolveConvex())) return Array.from(this.peers.values());
		try {
			const rows = (await this._client.query(
				this._api.vessels.list,
				{},
			)) as Array<{
				vesselId: string;
				name: string;
				url: string;
				ownerId: string;
				capabilities: string[];
				model: string;
				region: string;
				startedAt: number;
				lastHeartbeat: number;
				activeSessions: number;
				maxSessions: number;
			}>;
			for (const row of rows) {
				if (row.vesselId === this.vesselInfo.id) continue;
				this.addPeer({
					id: row.vesselId,
					name: row.name,
					url: row.url,
					ownerId: row.ownerId,
					capabilities: row.capabilities,
					model: row.model,
					region: row.region,
					startedAt: row.startedAt,
					lastHeartbeat: row.lastHeartbeat,
					activeSessions: row.activeSessions,
					maxSessions: row.maxSessions,
				});
			}
			return Array.from(this.peers.values());
		} catch {
			return Array.from(this.peers.values());
		}
	}

	addPeer(vessel: VesselInfo): void {
		if (vessel.id === this.vesselInfo.id) return;
		this.peers.set(vessel.id, vessel);
	}

	removePeer(vesselId: string): void {
		this.peers.delete(vesselId);
		const ws = this.connections.get(vesselId);
		if (ws) {
			ws.close();
			this.connections.delete(vesselId);
		}
	}

	getPeers(): VesselInfo[] {
		return Array.from(this.peers.values());
	}

	findByCapability(capability: string): VesselInfo[] {
		return this.getPeers().filter((v) => v.capabilities.includes(capability));
	}

	findBestForTask(requiredCapabilities: string[]): VesselInfo | null {
		const candidates = this.getPeers().filter((v) => {
			return requiredCapabilities.every((cap) => v.capabilities.includes(cap));
		});

		if (candidates.length === 0) return null;

		// Prefer: least loaded, then most capable
		return candidates.sort((a, b) => {
			const loadA = a.activeSessions / a.maxSessions;
			const loadB = b.activeSessions / b.maxSessions;
			if (loadA !== loadB) return loadA - loadB;
			return b.capabilities.length - a.capabilities.length;
		})[0];
	}

	// MARK: - Connection Management

	private getOrConnect(vesselId: string): WebSocket | null {
		const existing = this.connections.get(vesselId);
		if (existing && existing.readyState === WebSocket.OPEN) return existing;

		const peer = this.peers.get(vesselId);
		if (!peer) return null;

		try {
			const ws = new WebSocket(peer.url);

			ws.onopen = () => {
				this.connections.set(vesselId, ws);
				// Send auth + capability exchange
				this.sendRaw(ws, {
					id: this.genId(),
					from: this.vesselInfo.id,
					to: vesselId,
					type: "capability-query",
					payload: {
						vesselInfo: this.vesselInfo,
					},
					timestamp: Date.now(),
				});
			};

			ws.onmessage = (event) => {
				try {
					const msg = JSON.parse(String(event.data)) as VesselMessage;
					this.handleMessage(msg);
				} catch {}
			};

			ws.onclose = () => {
				this.connections.delete(vesselId);
			};

			ws.onerror = () => {
				this.connections.delete(vesselId);
			};

			return ws;
		} catch {
			return null;
		}
	}

	// MARK: - Messaging

	send(
		to: string,
		type: VesselMessage["type"],
		payload: Record<string, unknown>,
	): void {
		const ws = this.getOrConnect(to);
		if (!ws) return;

		this.sendRaw(ws, {
			id: this.genId(),
			from: this.vesselInfo.id,
			to,
			type,
			payload,
			timestamp: Date.now(),
		});
	}

	private sendRaw(ws: WebSocket, msg: VesselMessage): void {
		if (ws.readyState === WebSocket.OPEN) {
			ws.send(JSON.stringify(msg));
		}
	}

	/**
	 * Send a task to a remote vessel and wait for the result.
	 */
	async delegateTask(
		vesselId: string,
		task: TaskPayload,
		timeoutMs: number = 120_000,
	): Promise<TaskResult> {
		const correlationId = this.genId();

		return new Promise<TaskResult>((resolve, reject) => {
			const timer = setTimeout(() => {
				this.pendingRequests.delete(correlationId);
				reject(
					new Error(
						`Task delegation to ${vesselId} timed out after ${timeoutMs}ms`,
					),
				);
			}, timeoutMs);

			this.pendingRequests.set(correlationId, {
				resolve: (msg: VesselMessage) => {
					clearTimeout(timer);
					this.pendingRequests.delete(correlationId);
					resolve(msg.payload as unknown as TaskResult);
				},
				reject: (err: Error) => {
					clearTimeout(timer);
					this.pendingRequests.delete(correlationId);
					reject(err);
				},
				timer,
			});

			this.send(vesselId, "task", {
				...task,
				correlationId,
			});
		});
	}

	/**
	 * Delegate a task to the best available vessel for the required capabilities.
	 */
	async delegateTobestVessel(
		task: TaskPayload,
		requiredCapabilities: string[] = ["code"],
		timeoutMs?: number,
	): Promise<TaskResult & { vesselId: string }> {
		const vessel = this.findBestForTask(requiredCapabilities);
		if (!vessel) {
			return {
				status: "failed",
				output: "",
				durationMs: 0,
				error: `No vessel found with capabilities: ${requiredCapabilities.join(", ")}`,
				vesselId: "",
			};
		}

		const result = await this.delegateTask(vessel.id, task, timeoutMs);
		return { ...result, vesselId: vessel.id };
	}

	// MARK: - Message Handling

	private handleMessage(msg: VesselMessage): void {
		// Handle correlation-based responses
		if (msg.type === "result" && msg.correlationId) {
			const pending = this.pendingRequests.get(msg.correlationId);
			if (pending) {
				pending.resolve(msg);
				return;
			}
		}

		// Handle capability exchange
		if (msg.type === "capability-query") {
			const peerInfo = msg.payload.vesselInfo as VesselInfo;
			if (peerInfo) this.addPeer(peerInfo);

			// Respond with our capabilities
			const ws = this.connections.get(msg.from);
			if (ws) {
				this.sendRaw(ws, {
					id: this.genId(),
					from: this.vesselInfo.id,
					to: msg.from,
					type: "capability-response",
					payload: { vesselInfo: this.vesselInfo },
					timestamp: Date.now(),
				});
			}
		}

		if (msg.type === "capability-response") {
			const peerInfo = msg.payload.vesselInfo as VesselInfo;
			if (peerInfo) this.addPeer(peerInfo);
		}

		// Handle incoming tasks
		if (msg.type === "task" && this.taskHandler) {
			const task = msg.payload as unknown as TaskPayload & {
				correlationId?: string;
			};
			const startTime = Date.now();

			this.taskHandler(task, msg.from)
				.then((result) => {
					const ws = this.connections.get(msg.from);
					if (ws) {
						this.sendRaw(ws, {
							id: this.genId(),
							from: this.vesselInfo.id,
							to: msg.from,
							type: "result",
							payload: result as unknown as Record<string, unknown>,
							correlationId: task.correlationId,
							timestamp: Date.now(),
						});
					}
				})
				.catch((err) => {
					const ws = this.connections.get(msg.from);
					if (ws) {
						this.sendRaw(ws, {
							id: this.genId(),
							from: this.vesselInfo.id,
							to: msg.from,
							type: "result",
							payload: {
								status: "failed",
								output: "",
								durationMs: Date.now() - startTime,
								error: String(err),
							},
							correlationId: task.correlationId,
							timestamp: Date.now(),
						});
					}
				});
		}

		// Handle heartbeats
		if (msg.type === "heartbeat") {
			const peer = this.peers.get(msg.from);
			if (peer) {
				peer.lastHeartbeat = Date.now();
				if (typeof msg.payload.activeSessions === "number") {
					peer.activeSessions = msg.payload.activeSessions;
				}
			}
		}

		// Forward to generic handler
		this.messageHandler?.(msg);
	}

	// MARK: - Event Handlers

	onMessage(handler: (msg: VesselMessage) => void): void {
		this.messageHandler = handler;
	}

	onTask(
		handler: (task: TaskPayload, from: string) => Promise<TaskResult>,
	): void {
		this.taskHandler = handler;
	}

	// MARK: - Heartbeat & Discovery

	private startHeartbeat(): void {
		this.heartbeatInterval = setInterval(() => {
			this.vesselInfo.lastHeartbeat = Date.now();

			this.convexHeartbeat().catch(() => {});

			// Send heartbeat to all connected peers
			for (const [id, ws] of this.connections) {
				if (ws.readyState === WebSocket.OPEN) {
					this.sendRaw(ws, {
						id: this.genId(),
						from: this.vesselInfo.id,
						to: id,
						type: "heartbeat",
						payload: {
							activeSessions: this.vesselInfo.activeSessions,
						},
						timestamp: Date.now(),
					});
				}
			}

			// Prune stale peers (no heartbeat in 90s)
			const now = Date.now();
			for (const [id, peer] of this.peers) {
				if (now - peer.lastHeartbeat > 90_000) {
					this.removePeer(id);
				}
			}
		}, 30_000);

		if (
			this.heartbeatInterval &&
			typeof this.heartbeatInterval === "object" &&
			"unref" in this.heartbeatInterval
		) {
			this.heartbeatInterval.unref();
		}
	}

	private startDiscovery(): void {
		this.discoveryInterval = setInterval(() => {
			this.discoverPeers().catch(() => {});
		}, 60_000);

		if (
			this.discoveryInterval &&
			typeof this.discoveryInterval === "object" &&
			"unref" in this.discoveryInterval
		) {
			this.discoveryInterval.unref();
		}
	}

	// MARK: - Status

	getInfo(): Readonly<VesselInfo> {
		return { ...this.vesselInfo };
	}

	updateSessionCount(count: number): void {
		this.vesselInfo.activeSessions = count;
	}

	status(): {
		vessel: VesselInfo;
		peers: number;
		connected: number;
		pendingTasks: number;
	} {
		return {
			vessel: { ...this.vesselInfo },
			peers: this.peers.size,
			connected: Array.from(this.connections.values()).filter(
				(ws) => ws.readyState === WebSocket.OPEN,
			).length,
			pendingTasks: this.pendingRequests.size,
		};
	}

	// MARK: - Helpers

	private genId(): string {
		return `vmsg-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
	}
}
