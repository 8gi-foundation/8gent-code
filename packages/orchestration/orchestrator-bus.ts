/**
 * OrchestratorBus — Central message bus for multi-agent coordination.
 *
 * EventEmitter-based. Eight (primary agent) is always the orchestrator.
 * Sub-agents communicate only through this bus — never peer-to-peer.
 */

import { EventEmitter } from "events";
import type { BMADPersona } from "./personas";

// ── Types ─────────────────────────────────────────────────────

export interface ChatMessage {
  id: string;
  role: "user" | "assistant" | "system";
  content: string;
  agentId: string;  // Which agent sent/received this
  timestamp: Date;
}

export interface OrchestratedAgent {
  id: string;
  persona: BMADPersona;
  worktreePath: string | null;
  task: string;
  status: "spawning" | "running" | "paused" | "completed" | "failed";
  chatHistory: ChatMessage[];
  spawnedAt: Date;
  completedAt?: Date;
  /** Reference to the Agent instance — set externally after spawn */
  agentRef?: any;
}

export interface SpawnRequest {
  id: string;
  persona: string;
  task: string;
  reason: string;
  autoApproved: boolean;
  status: "pending" | "approved" | "rejected";
  createdAt: Date;
}

export type BusEvent =
  | "agent:spawned"
  | "agent:completed"
  | "agent:failed"
  | "agent:killed"
  | "agent:message"
  | "spawn:request"
  | "spawn:approved"
  | "spawn:rejected"
  | "chat:message"
  | "worktree:changes"
  | "worktree:merged";

// ── OrchestratorBus ───────────────────────────────────────────

export class OrchestratorBus extends EventEmitter {
  private agents: Map<string, OrchestratedAgent> = new Map();
  private pendingSpawns: Map<string, SpawnRequest> = new Map();
  private autoSpawn = false;
  private _nextId = 0;

  constructor() {
    super();
    this.setMaxListeners(50); // Allow many agent listeners
  }

  // ── Agent Registry ──────────────────────────────────────────

  /**
   * Register a new orchestrated agent.
   */
  registerAgent(
    persona: BMADPersona,
    task: string,
    worktreePath: string | null
  ): OrchestratedAgent {
    const id = `${persona.id}-${++this._nextId}`;
    const agent: OrchestratedAgent = {
      id,
      persona,
      worktreePath,
      task,
      status: "spawning",
      chatHistory: [],
      spawnedAt: new Date(),
    };

    this.agents.set(id, agent);
    this.emit("agent:spawned", agent);
    return agent;
  }

  /**
   * Update an agent's status.
   */
  updateAgentStatus(agentId: string, status: OrchestratedAgent["status"]): void {
    const agent = this.agents.get(agentId);
    if (!agent) return;

    agent.status = status;
    if (status === "completed" || status === "failed") {
      agent.completedAt = new Date();
      this.emit(`agent:${status}`, agent);
    }
  }

  /**
   * Set the Agent class reference on an orchestrated agent.
   */
  setAgentRef(agentId: string, ref: any): void {
    const agent = this.agents.get(agentId);
    if (agent) agent.agentRef = ref;
  }

  /**
   * Remove an agent from the registry.
   */
  killAgent(agentId: string): OrchestratedAgent | undefined {
    const agent = this.agents.get(agentId);
    if (!agent) return undefined;

    agent.status = "failed";
    agent.completedAt = new Date();

    // Cleanup agent ref
    if (agent.agentRef?.cleanup) {
      agent.agentRef.cleanup().catch(() => {});
    }
    if (agent.agentRef?.abort) {
      agent.agentRef.abort();
    }

    this.agents.delete(agentId);
    this.emit("agent:killed", agent);
    return agent;
  }

  /**
   * Get all active agents.
   */
  getAgents(): OrchestratedAgent[] {
    return Array.from(this.agents.values());
  }

  /**
   * Get active agent count.
   */
  getAgentCount(): number {
    return this.agents.size;
  }

  /**
   * Get a specific agent by ID.
   */
  getAgent(agentId: string): OrchestratedAgent | undefined {
    return this.agents.get(agentId);
  }

  /**
   * Find agents by persona ID.
   */
  findByPersona(personaId: string): OrchestratedAgent[] {
    return this.getAgents().filter(a => a.persona.id === personaId);
  }

  // ── Spawn Requests ──────────────────────────────────────────

  /**
   * Submit a spawn request (from Eight suggesting a sub-agent).
   * If autoSpawn is on, auto-approves immediately.
   */
  requestSpawn(persona: string, task: string, reason: string): SpawnRequest {
    const request: SpawnRequest = {
      id: `spawn-${++this._nextId}`,
      persona,
      task,
      reason,
      autoApproved: this.autoSpawn,
      status: this.autoSpawn ? "approved" : "pending",
      createdAt: new Date(),
    };

    this.pendingSpawns.set(request.id, request);
    this.emit("spawn:request", request);

    if (this.autoSpawn) {
      this.emit("spawn:approved", request);
    }

    return request;
  }

  /**
   * Approve a pending spawn request.
   */
  approveSpawn(requestId: string): SpawnRequest | undefined {
    const request = this.pendingSpawns.get(requestId);
    if (!request || request.status !== "pending") return undefined;

    request.status = "approved";
    this.emit("spawn:approved", request);
    return request;
  }

  /**
   * Reject a pending spawn request.
   */
  rejectSpawn(requestId: string): SpawnRequest | undefined {
    const request = this.pendingSpawns.get(requestId);
    if (!request || request.status !== "pending") return undefined;

    request.status = "rejected";
    this.pendingSpawns.delete(requestId);
    this.emit("spawn:rejected", request);
    return request;
  }

  /**
   * Get pending spawn requests.
   */
  getPendingSpawns(): SpawnRequest[] {
    return Array.from(this.pendingSpawns.values()).filter(s => s.status === "pending");
  }

  // ── Chat Routing ────────────────────────────────────────────

  /**
   * Route a chat message to a specific agent.
   */
  routeMessage(agentId: string, message: ChatMessage): void {
    const agent = this.agents.get(agentId);
    if (agent) {
      agent.chatHistory.push(message);
    }
    this.emit("chat:message", { agentId, message });
  }

  /**
   * Broadcast a message to all active agents.
   */
  broadcastMessage(message: ChatMessage): void {
    for (const agent of this.agents.values()) {
      agent.chatHistory.push(message);
    }
    this.emit("chat:message", { agentId: "*", message });
  }

  // ── Auto-Spawn ──────────────────────────────────────────────

  /**
   * Toggle auto-spawn mode.
   */
  setAutoSpawn(enabled: boolean): void {
    this.autoSpawn = enabled;
  }

  /**
   * Check if auto-spawn is enabled.
   */
  isAutoSpawnEnabled(): boolean {
    return this.autoSpawn;
  }

  // ── Cleanup ─────────────────────────────────────────────────

  /**
   * Kill all agents and clear state.
   */
  async shutdown(): Promise<void> {
    for (const agentId of Array.from(this.agents.keys())) {
      this.killAgent(agentId);
    }
    this.pendingSpawns.clear();
    this.removeAllListeners();
  }
}

// ── Singleton ─────────────────────────────────────────────────

let _bus: OrchestratorBus | null = null;

export function getOrchestratorBus(): OrchestratorBus {
  if (!_bus) {
    _bus = new OrchestratorBus();
  }
  return _bus;
}
