/**
 * Control plane WebSocket connection.
 *
 * Registers vessel on connect. Handles inbound mcp:call and task:invoke.
 * Auto-reconnects with exponential backoff.
 */

import { vesselInvoke } from "./invoke";
import { buildManifest } from "./manifest";

const CONTROL_PLANE_URL = process.env.CONTROL_PLANE_URL ?? "wss://8gi-board-plane.fly.dev";

let ws: WebSocket | null = null;
let reconnectDelay = 2000;
const MAX_RECONNECT_DELAY = 60_000;

export function connectControlPlane(): void {
  const code = process.env.VESSEL_CODE ?? "???";

  try {
    ws = new WebSocket(CONTROL_PLANE_URL);

    ws.onopen = () => {
      console.log(`[${code}] Connected to control plane`);
      reconnectDelay = 2000;

      // Register with the control plane
      ws!.send(JSON.stringify({
        type: "vessel:register",
        manifest: buildManifest(),
      }));
    };

    ws.onmessage = async (event) => {
      let msg: { type?: string; request_id?: string; task?: string; context?: string; from?: string } = {};
      try {
        msg = JSON.parse(event.data as string);
      } catch {
        return;
      }

      if (msg.type === "task:invoke") {
        const result = await vesselInvoke({
          task: msg.task ?? "",
          context: msg.context,
          from: msg.from,
        });

        ws?.send(JSON.stringify({
          type: "task:result",
          request_id: msg.request_id,
          ...result,
        }));
      }

      if (msg.type === "ping") {
        ws?.send(JSON.stringify({ type: "pong", code }));
      }
    };

    ws.onclose = (event) => {
      console.log(`[${code}] Control plane disconnected (${event.code}). Reconnect in ${reconnectDelay / 1000}s`);
      scheduleReconnect();
    };

    ws.onerror = (err) => {
      console.error(`[${code}] Control plane WS error:`, err);
    };

  } catch (err: any) {
    console.error(`[${code}] Failed to connect to control plane:`, err.message);
    scheduleReconnect();
  }
}

function scheduleReconnect(): void {
  setTimeout(() => {
    connectControlPlane();
  }, reconnectDelay);

  reconnectDelay = Math.min(reconnectDelay * 2, MAX_RECONNECT_DELAY);
}
