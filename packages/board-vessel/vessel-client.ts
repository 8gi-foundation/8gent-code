/**
 * WebSocket client that connects a vessel worker to the Control Plane.
 *
 * Handles auth handshake, task dispatch, heartbeats, and reconnection
 * with exponential backoff. The vessel never talks to Discord directly -
 * all communication goes through the control plane.
 */

import type {
  BoardTask,
  PlaneToVessel,
  VesselStatus,
  VesselToPlane,
} from "../board-plane/types";

const HEARTBEAT_INTERVAL_MS = 30_000;
const MAX_BACKOFF_MS = 30_000;
const BASE_BACKOFF_MS = 1_000;

export class VesselClient {
  private ws: WebSocket | null = null;
  private reconnectAttempts = 0;
  private heartbeatTimer: ReturnType<typeof setInterval> | null = null;
  private currentTaskId: string | null = null;
  private closed = false;

  constructor(
    private controlPlaneUrl: string,
    private authToken: string,
    private memberCode: string,
    private onTask: (task: BoardTask) => Promise<string>,
    private getStatus: () => VesselStatus,
  ) {}

  connect(): void {
    if (this.closed) return;

    console.log(
      `[vessel-client] Connecting to ${this.controlPlaneUrl} (attempt ${this.reconnectAttempts + 1})`,
    );
    this.ws = new WebSocket(this.controlPlaneUrl);

    this.ws.addEventListener("open", () => {
      console.log("[vessel-client] Connected, sending auth");
      this.send({ type: "auth", token: this.authToken, memberCode: this.memberCode });
    });

    this.ws.addEventListener("message", (event) => {
      try {
        const msg = JSON.parse(String(event.data)) as PlaneToVessel;
        this.handleMessage(msg);
      } catch (err) {
        console.error("[vessel-client] Failed to parse message:", err);
      }
    });

    this.ws.addEventListener("close", (event) => {
      console.log(`[vessel-client] Disconnected: ${event.code} ${event.reason}`);
      this.stopHeartbeat();
      this.reconnect();
    });

    this.ws.addEventListener("error", (err) => {
      console.error("[vessel-client] WebSocket error:", err);
    });
  }

  private handleMessage(msg: PlaneToVessel): void {
    switch (msg.type) {
      case "auth:ok":
        console.log(`[vessel-client] Authenticated as ${msg.vesselId}`);
        this.reconnectAttempts = 0;
        this.startHeartbeat();
        this.send({ type: "ready" });
        break;

      case "auth:fail":
        console.error(`[vessel-client] Auth failed: ${msg.reason}`);
        this.closed = true;
        this.ws?.close();
        process.exit(1);
        break;

      case "task:assign":
        this.handleTask(msg.task);
        break;

      case "heartbeat:ack":
        // Control plane acknowledged our heartbeat
        break;

      case "shutdown":
        console.log("[vessel-client] Shutdown requested by control plane");
        this.close();
        process.exit(0);
        break;
    }
  }

  private async handleTask(task: BoardTask): Promise<void> {
    this.currentTaskId = task.id;
    console.log(`[vessel-client] Task ${task.id}: ${task.content.slice(0, 80)}`);

    try {
      const response = await this.onTask(task);
      this.send({ type: "task:complete", taskId: task.id, response });
    } catch (err) {
      const error = err instanceof Error ? err.message : String(err);
      console.error(`[vessel-client] Task ${task.id} failed:`, error);
      this.send({ type: "task:failed", taskId: task.id, error });
    } finally {
      this.currentTaskId = null;
    }
  }

  private send(msg: VesselToPlane): void {
    if (this.ws?.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify(msg));
    }
  }

  private startHeartbeat(): void {
    this.stopHeartbeat();
    this.heartbeatTimer = setInterval(() => {
      this.send({ type: "heartbeat", status: this.getStatus() });
    }, HEARTBEAT_INTERVAL_MS);
  }

  private stopHeartbeat(): void {
    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = null;
    }
  }

  private reconnect(): void {
    if (this.closed) return;
    this.reconnectAttempts++;
    const backoff = Math.min(
      BASE_BACKOFF_MS * Math.pow(2, this.reconnectAttempts - 1),
      MAX_BACKOFF_MS,
    );
    console.log(`[vessel-client] Reconnecting in ${backoff}ms`);
    setTimeout(() => this.connect(), backoff);
  }

  close(): void {
    this.closed = true;
    this.stopHeartbeat();
    this.ws?.close();
    this.ws = null;
  }
}
