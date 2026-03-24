/**
 * Agent Mesh - Universal inter-agent communication for all coding agents
 *
 * Any process on the machine can join the mesh:
 * - Claude Code sessions (via hook)
 * - 8gent Code instances (native)
 * - OpenCode, Cursor, Codex, etc. (via lightweight adapter)
 * - Lil Eight dock pet (observer + orchestrator)
 *
 * Uses filesystem-based IPC (no daemon required):
 * - ~/.8gent/mesh/registry.json - all active agents
 * - ~/.8gent/mesh/messages/<agentId>/ - per-agent inbox
 * - ~/.8gent/mesh/broadcast/ - messages to all agents
 *
 * Protocol: JSON files, FIFO consumption, heartbeat-based liveness
 */

import { mkdirSync, writeFileSync, readFileSync, readdirSync, unlinkSync, existsSync, statSync } from "fs"
import { join } from "path"
import { homedir } from "os"

// MARK: - Types

export interface MeshAgent {
  id: string
  type: "claude-code" | "eight" | "opencode" | "cursor" | "codex" | "lil-eight" | "custom"
  name: string
  pid: number
  cwd: string
  startedAt: number
  lastHeartbeat: number
  capabilities: string[] // e.g. ["code", "computer-use", "browser", "orchestrate"]
  model?: string
  channel?: string // e.g. "terminal", "gui", "telegram"
}

export interface MeshMessage {
  id: string
  from: string // agentId
  to: string // agentId or "broadcast"
  type: "chat" | "task" | "status" | "request" | "response" | "event"
  content: string
  metadata?: Record<string, unknown>
  timestamp: number
  read?: boolean
}

// MARK: - Mesh Node

const MESH_DIR = join(homedir(), ".8gent", "mesh")
const REGISTRY_PATH = join(MESH_DIR, "registry.json")
const MESSAGES_DIR = join(MESH_DIR, "messages")
const BROADCAST_DIR = join(MESH_DIR, "broadcast")
const STALE_THRESHOLD_MS = 60_000 // 60s without heartbeat = stale

export class AgentMesh {
  readonly agentId: string
  private agent: MeshAgent
  private heartbeatInterval?: ReturnType<typeof setInterval>
  private watchInterval?: ReturnType<typeof setInterval>
  private onMessage?: (msg: MeshMessage) => void
  private onPeerJoin?: (agent: MeshAgent) => void
  private onPeerLeave?: (agentId: string) => void
  private knownPeers = new Set<string>()

  constructor(agent: Omit<MeshAgent, "id" | "lastHeartbeat" | "startedAt">) {
    this.agentId = `${agent.type}-${agent.pid}-${Date.now().toString(36)}`
    this.agent = {
      ...agent,
      id: this.agentId,
      startedAt: Date.now(),
      lastHeartbeat: Date.now(),
    }

    // Ensure directories
    mkdirSync(MESH_DIR, { recursive: true })
    mkdirSync(MESSAGES_DIR, { recursive: true })
    mkdirSync(BROADCAST_DIR, { recursive: true })
    mkdirSync(join(MESSAGES_DIR, this.agentId), { recursive: true })
  }

  // MARK: - Lifecycle

  join(): void {
    this.register()
    this.startHeartbeat()
    this.startWatching()
    console.log(`[mesh] Joined as ${this.agentId} (${this.agent.type}/${this.agent.name})`)
  }

  leave(): void {
    this.heartbeatInterval && clearInterval(this.heartbeatInterval)
    this.watchInterval && clearInterval(this.watchInterval)
    this.unregister()
    console.log(`[mesh] Left mesh: ${this.agentId}`)
  }

  // MARK: - Registry

  private register(): void {
    const registry = this.readRegistry()
    registry[this.agentId] = this.agent
    this.writeRegistry(registry)
  }

  private unregister(): void {
    const registry = this.readRegistry()
    delete registry[this.agentId]
    this.writeRegistry(registry)
  }

  private startHeartbeat(): void {
    this.heartbeatInterval = setInterval(() => {
      const registry = this.readRegistry()
      if (registry[this.agentId]) {
        registry[this.agentId].lastHeartbeat = Date.now()
        this.writeRegistry(registry)
      }
      this.cleanStaleAgents(registry)
    }, 10_000) // heartbeat every 10s
  }

  private cleanStaleAgents(registry: Record<string, MeshAgent>): void {
    const now = Date.now()
    let changed = false
    for (const [id, agent] of Object.entries(registry)) {
      if (id === this.agentId) continue
      if (now - agent.lastHeartbeat > STALE_THRESHOLD_MS) {
        // Check if process is actually dead
        if (!this.isProcessAlive(agent.pid)) {
          delete registry[id]
          changed = true
          this.onPeerLeave?.(id)
          this.knownPeers.delete(id)
          console.log(`[mesh] Cleaned stale agent: ${id} (pid ${agent.pid} dead)`)
        }
      }
    }
    if (changed) this.writeRegistry(registry)
  }

  private isProcessAlive(pid: number): boolean {
    try {
      process.kill(pid, 0) // signal 0 = check existence
      return true
    } catch {
      return false
    }
  }

  // MARK: - Peer Discovery

  listPeers(): MeshAgent[] {
    const registry = this.readRegistry()
    return Object.values(registry).filter(a => a.id !== this.agentId)
  }

  listAllAgents(): MeshAgent[] {
    return Object.values(this.readRegistry())
  }

  getPeer(agentId: string): MeshAgent | undefined {
    return this.readRegistry()[agentId]
  }

  findByType(type: MeshAgent["type"]): MeshAgent[] {
    return this.listPeers().filter(a => a.type === type)
  }

  findByCapability(cap: string): MeshAgent[] {
    return this.listPeers().filter(a => a.capabilities.includes(cap))
  }

  // MARK: - Messaging

  send(to: string, type: MeshMessage["type"], content: string, metadata?: Record<string, unknown>): void {
    const msg: MeshMessage = {
      id: `msg-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`,
      from: this.agentId,
      to,
      type,
      content,
      metadata,
      timestamp: Date.now(),
    }

    if (to === "broadcast") {
      // Write to broadcast dir
      writeFileSync(join(BROADCAST_DIR, `${msg.id}.json`), JSON.stringify(msg, null, 2))
    } else {
      // Write to target agent's inbox
      const inbox = join(MESSAGES_DIR, to)
      mkdirSync(inbox, { recursive: true })
      writeFileSync(join(inbox, `${msg.id}.json`), JSON.stringify(msg, null, 2))
    }
  }

  broadcast(type: MeshMessage["type"], content: string, metadata?: Record<string, unknown>): void {
    this.send("broadcast", type, content, metadata)
  }

  // Read and consume messages from own inbox
  consume(): MeshMessage[] {
    const inbox = join(MESSAGES_DIR, this.agentId)
    if (!existsSync(inbox)) return []

    const messages: MeshMessage[] = []
    const files = readdirSync(inbox).filter(f => f.endsWith(".json")).sort()

    for (const file of files) {
      try {
        const path = join(inbox, file)
        const msg = JSON.parse(readFileSync(path, "utf-8")) as MeshMessage
        messages.push(msg)
        unlinkSync(path) // consume = delete
      } catch {}
    }

    return messages
  }

  // Peek without consuming
  peek(): MeshMessage[] {
    const inbox = join(MESSAGES_DIR, this.agentId)
    if (!existsSync(inbox)) return []

    return readdirSync(inbox)
      .filter(f => f.endsWith(".json"))
      .sort()
      .map(f => {
        try {
          return JSON.parse(readFileSync(join(inbox, f), "utf-8")) as MeshMessage
        } catch { return null }
      })
      .filter(Boolean) as MeshMessage[]
  }

  // Read broadcast messages (non-destructive, returns since timestamp)
  readBroadcasts(since: number = 0): MeshMessage[] {
    if (!existsSync(BROADCAST_DIR)) return []

    return readdirSync(BROADCAST_DIR)
      .filter(f => f.endsWith(".json"))
      .map(f => {
        try {
          const msg = JSON.parse(readFileSync(join(BROADCAST_DIR, f), "utf-8")) as MeshMessage
          return msg.timestamp > since ? msg : null
        } catch { return null }
      })
      .filter(Boolean) as MeshMessage[]
  }

  // MARK: - Watch for changes

  onMessageReceived(handler: (msg: MeshMessage) => void): void {
    this.onMessage = handler
  }

  onPeerJoined(handler: (agent: MeshAgent) => void): void {
    this.onPeerJoin = handler
  }

  onPeerLeft(handler: (agentId: string) => void): void {
    this.onPeerLeave = handler
  }

  private startWatching(): void {
    // Initialize known peers
    for (const peer of this.listPeers()) {
      this.knownPeers.add(peer.id)
    }

    this.watchInterval = setInterval(() => {
      // Check for new messages
      const msgs = this.consume()
      for (const msg of msgs) {
        this.onMessage?.(msg)
      }

      // Check for peer changes
      const currentPeers = new Set(this.listPeers().map(p => p.id))
      for (const id of currentPeers) {
        if (!this.knownPeers.has(id)) {
          this.knownPeers.add(id)
          this.onPeerJoin?.(this.getPeer(id)!)
        }
      }
      for (const id of this.knownPeers) {
        if (!currentPeers.has(id)) {
          this.knownPeers.delete(id)
          this.onPeerLeave?.(id)
        }
      }
    }, 2_000) // poll every 2s
  }

  // MARK: - File I/O

  private readRegistry(): Record<string, MeshAgent> {
    try {
      return JSON.parse(readFileSync(REGISTRY_PATH, "utf-8"))
    } catch {
      return {}
    }
  }

  private writeRegistry(registry: Record<string, MeshAgent>): void {
    writeFileSync(REGISTRY_PATH, JSON.stringify(registry, null, 2))
  }

  // MARK: - Convenience

  /** Ask a specific agent to do something and wait for response */
  async request(to: string, content: string, timeoutMs: number = 30_000): Promise<MeshMessage | null> {
    const requestId = `req-${Date.now().toString(36)}`
    this.send(to, "request", content, { requestId })

    const deadline = Date.now() + timeoutMs
    while (Date.now() < deadline) {
      const msgs = this.peek()
      const response = msgs.find(m => m.type === "response" && m.metadata?.requestId === requestId)
      if (response) {
        // Consume it
        const inbox = join(MESSAGES_DIR, this.agentId)
        const files = readdirSync(inbox).filter(f => f.endsWith(".json"))
        for (const f of files) {
          try {
            const msg = JSON.parse(readFileSync(join(inbox, f), "utf-8"))
            if (msg.id === response.id) {
              unlinkSync(join(inbox, f))
              break
            }
          } catch {}
        }
        return response
      }
      await new Promise(r => setTimeout(r, 500))
    }
    return null
  }

  /** Get mesh status summary */
  status(): { agents: number; types: Record<string, number>; messages: number } {
    const agents = this.listAllAgents()
    const types: Record<string, number> = {}
    for (const a of agents) {
      types[a.type] = (types[a.type] || 0) + 1
    }
    const inbox = join(MESSAGES_DIR, this.agentId)
    const messages = existsSync(inbox) ? readdirSync(inbox).filter(f => f.endsWith(".json")).length : 0
    return { agents: agents.length, types, messages }
  }
}

// MARK: - Quick Join (one-liner for any agent)

export function joinMesh(opts: {
  type: MeshAgent["type"]
  name: string
  capabilities?: string[]
  model?: string
  channel?: string
}): AgentMesh {
  const mesh = new AgentMesh({
    type: opts.type,
    name: opts.name,
    pid: process.pid,
    cwd: process.cwd(),
    capabilities: opts.capabilities || ["code"],
    model: opts.model,
    channel: opts.channel || "terminal",
  })
  mesh.join()

  // Clean exit
  process.on("exit", () => mesh.leave())
  process.on("SIGINT", () => { mesh.leave(); process.exit(0) })
  process.on("SIGTERM", () => { mesh.leave(); process.exit(0) })

  return mesh
}
