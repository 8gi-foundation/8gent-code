/**
 * Board Plane - Shared types for the control plane system.
 *
 * Types for board members, durable tasks, WebSocket protocol,
 * vessel status, and Discord gateway events.
 */

// Board member identity
export interface BoardMember {
  code: BoardMemberCode;
  name: string;
  role: string;
  systemPrompt: string;
  discordBotId: string;
  discordBotToken: string;
}

export type BoardMemberCode = "8EO" | "8TO" | "8PO" | "8DO" | "8SO" | "8CO";

// Durable task (SQLite row)
export interface BoardTask {
  id: string;
  status: "pending" | "assigned" | "running" | "completed" | "failed" | "retry";
  memberCode: string;
  channelId: string;
  messageId: string;
  authorId: string;
  authorName: string;
  content: string;
  systemPrompt: string;
  contextMessages: Array<{ role: string; content: string }>;
  response: string | null;
  vesselId: string | null;
  retryCount: number;
  createdAt: number;
  assignedAt: number | null;
  completedAt: number | null;
  error: string | null;
}

// WebSocket protocol: Control Plane -> Vessel
export type PlaneToVessel =
  | { type: "auth:ok"; vesselId: string }
  | { type: "auth:fail"; reason: string }
  | { type: "task:assign"; task: BoardTask }
  | { type: "heartbeat:ack" }
  | { type: "shutdown" };

// WebSocket protocol: Vessel -> Control Plane
export type VesselToPlane =
  | { type: "auth"; token: string; memberCode: string }
  | { type: "task:complete"; taskId: string; response: string }
  | { type: "task:failed"; taskId: string; error: string }
  | { type: "heartbeat"; status: VesselStatus }
  | { type: "ready" };

export interface VesselStatus {
  memberCode: string;
  ollamaReady: boolean;
  modelLoaded: boolean;
  currentTaskId: string | null;
  uptimeSeconds: number;
  memoryMb: number;
}

// Discord Gateway event (simplified)
export interface DiscordMessage {
  id: string;
  channelId: string;
  guildId: string | null;
  author: { id: string; username: string; bot?: boolean };
  mentions: Array<{ id: string }>;
  content: string;
  timestamp: string;
}

// Control plane startup config
export interface ControlPlaneConfig {
  dbPath: string;
  vesselPort: number;
  vesselAuthToken: string;
  members: BoardMember[];
  rateLimitMs: number;
  staleTaskMaxAgeMs: number;
  healthCheckIntervalMs: number;
}
