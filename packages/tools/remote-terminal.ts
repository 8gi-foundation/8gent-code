/**
 * Remote Terminal Monitor — clsh pattern
 * Streams the agent's terminal output via WebSocket so you can watch from your phone.
 *
 * Usage:
 *   const server = new RemoteTerminalServer();
 *   const session = await server.start(8765);
 *   server.broadcast("Hello from 8gent!\r\n");
 *   // Open http://localhost:8765 in browser for xterm.js viewer
 *   server.stop();
 */

import { existsSync, readFileSync } from "fs";
import { join } from "path";
import * as os from "os";

// ============================================
// Types
// ============================================

interface RemoteSession {
  id: string;
  port: number;
  startedAt: number;
  clients: number;
  tunnelUrl?: string;
}

interface RemoteTerminalOptions {
  port?: number;
  maxScrollback?: number;
  enableTunnel?: boolean;
}

// ============================================
// Remote Terminal Server
// ============================================

export class RemoteTerminalServer {
  private sessions: Map<string, RemoteSession> = new Map();
  private server: any = null;
  private scrollback: string[] = [];
  private maxScrollback: number;
  private clientCount = 0;

  constructor(options?: { maxScrollback?: number }) {
    this.maxScrollback = options?.maxScrollback ?? 5000;
  }

  /** Start a WebSocket server that streams terminal output */
  async start(options?: RemoteTerminalOptions): Promise<RemoteSession> {
    if (this.server) {
      throw new Error("Remote terminal server already running. Call stop() first.");
    }

    const actualPort = options?.port ?? 8765;
    const sessionId = `session-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const self = this;

    this.server = Bun.serve({
      port: actualPort,
      fetch(req, server) {
        const url = new URL(req.url);

        if (url.pathname === "/ws") {
          const upgraded = server.upgrade(req, {
            data: { sessionId, connectedAt: Date.now() },
          });
          if (upgraded) return undefined;
          return new Response("WebSocket upgrade failed", { status: 400 });
        }

        if (url.pathname === "/health") {
          return Response.json({
            status: "ok",
            session: sessionId,
            clients: self.clientCount,
            uptime: Date.now() - (self.sessions.get(sessionId)?.startedAt ?? Date.now()),
            scrollbackLines: self.scrollback.length,
          });
        }

        // Serve the xterm.js viewer page
        return new Response(getViewerHTML(sessionId), {
          headers: { "Content-Type": "text/html; charset=utf-8" },
        });
      },
      websocket: {
        open(ws) {
          self.clientCount++;
          ws.subscribe("terminal");
          console.log(`[remote-terminal] Client connected (${self.clientCount} total)`);

          // Send scrollback history to newly connected clients
          if (self.scrollback.length > 0) {
            ws.send(JSON.stringify({
              type: "scrollback",
              data: self.scrollback.join(""),
            }));
          }

          ws.send(JSON.stringify({
            type: "meta",
            session: sessionId,
            clients: self.clientCount,
          }));

          // Update session client count
          const session = self.sessions.get(sessionId);
          if (session) session.clients = self.clientCount;
        },
        message(ws, msg) {
          // Handle commands from the viewer
          try {
            const parsed = JSON.parse(String(msg));
            if (parsed.type === "ping") {
              ws.send(JSON.stringify({ type: "pong", time: Date.now() }));
            }
            if (parsed.type === "resize") {
              // Could forward terminal resize events in the future
            }
          } catch {
            // Ignore malformed messages
          }
        },
        close(ws) {
          self.clientCount--;
          ws.unsubscribe("terminal");
          console.log(`[remote-terminal] Client disconnected (${self.clientCount} remaining)`);

          const session = self.sessions.get(sessionId);
          if (session) session.clients = self.clientCount;
        },
      },
    });

    const session: RemoteSession = {
      id: sessionId,
      port: actualPort,
      startedAt: Date.now(),
      clients: 0,
    };

    this.sessions.set(sessionId, session);

    console.log(`[remote-terminal] Server started on port ${actualPort}`);
    console.log(`[remote-terminal] View at: http://localhost:${actualPort}`);

    // Optionally create a tunnel for external access
    if (options?.enableTunnel) {
      const tunnelUrl = await this.createTunnel(actualPort);
      if (tunnelUrl) {
        session.tunnelUrl = tunnelUrl;
        console.log(`[remote-terminal] Tunnel URL: ${tunnelUrl}`);
      }
    }

    return session;
  }

  /** Broadcast text to all connected WebSocket clients */
  broadcast(text: string): void {
    if (!this.server) return;

    // Store in scrollback buffer
    this.scrollback.push(text);
    if (this.scrollback.length > this.maxScrollback) {
      this.scrollback = this.scrollback.slice(-Math.floor(this.maxScrollback * 0.8));
    }

    // Publish to all subscribed websockets
    this.server.publish("terminal", JSON.stringify({
      type: "output",
      data: text,
    }));
  }

  /** Broadcast a structured event (e.g. tool call, model switch) */
  broadcastEvent(event: { type: string; detail: string; timestamp?: number }): void {
    if (!this.server) return;
    this.server.publish("terminal", JSON.stringify({
      type: "event",
      event: event.type,
      detail: event.detail,
      timestamp: event.timestamp ?? Date.now(),
    }));
  }

  /** Get current session info */
  getSession(): RemoteSession | null {
    const sessions = Array.from(this.sessions.values());
    return sessions[sessions.length - 1] ?? null;
  }

  /** Get all sessions */
  getSessions(): RemoteSession[] {
    return Array.from(this.sessions.values());
  }

  /** Check if server is running */
  isRunning(): boolean {
    return this.server !== null;
  }

  /** Stop the server */
  stop(): void {
    if (this.server) {
      this.server.stop();
      this.server = null;
      this.clientCount = 0;
      this.scrollback = [];
      console.log("[remote-terminal] Server stopped");
    }
  }

  /** Try to create a tunnel URL for external access */
  async createTunnel(port: number): Promise<string | null> {
    // Try localhost.run (free, no install needed)
    try {
      const proc = Bun.spawn(
        ["ssh", "-o", "StrictHostKeyChecking=no", "-R", `80:localhost:${port}`, "nokey@localhost.run"],
        { stdout: "pipe", stderr: "pipe", timeout: 15000 }
      );

      const output = await new Response(proc.stdout).text();
      const urlMatch = output.match(/https?:\/\/[^\s]+\.localhost\.run[^\s]*/);
      return urlMatch ? urlMatch[0] : null;
    } catch {
      // localhost.run not available, try bore if installed
      try {
        const proc = Bun.spawn(["which", "bore"], { stdout: "pipe" });
        const borePath = (await new Response(proc.stdout).text()).trim();
        if (borePath) {
          // bore is available but we'd need to run it async
          // For now, just return null and let the user set up their own tunnel
          return null;
        }
      } catch {}
      return null;
    }
  }
}

// ============================================
// xterm.js Viewer HTML
// ============================================

function getViewerHTML(sessionId: string): string {
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0, maximum-scale=1.0, user-scalable=no">
  <title>8gent Remote Terminal</title>
  <link rel="stylesheet" href="https://cdn.jsdelivr.net/npm/xterm@5.3.0/css/xterm.min.css">
  <style>
    * { box-sizing: border-box; margin: 0; padding: 0; }
    body { background: #1a1a2e; font-family: 'JetBrains Mono', 'Fira Code', monospace; overflow: hidden; }
    #header {
      padding: 8px 16px;
      background: #16213e;
      color: #0f0;
      font-size: 13px;
      display: flex;
      justify-content: space-between;
      align-items: center;
      border-bottom: 1px solid #0f3460;
    }
    #header .session { color: #888; font-size: 11px; }
    #header .clients { color: #0af; }
    #header .status { display: inline-block; width: 8px; height: 8px; border-radius: 50%; background: #0f0; margin-right: 6px; }
    #header .status.disconnected { background: #f00; }
    #terminal { width: 100%; height: calc(100vh - 36px); }
  </style>
</head>
<body>
  <div id="header">
    <span><span class="status" id="statusDot"></span>8gent Remote Terminal</span>
    <span class="clients" id="clientCount"></span>
    <span class="session">${sessionId}</span>
  </div>
  <div id="terminal"></div>
  <script src="https://cdn.jsdelivr.net/npm/xterm@5.3.0/lib/xterm.min.js"></script>
  <script src="https://cdn.jsdelivr.net/npm/xterm-addon-fit@0.8.0/lib/xterm-addon-fit.min.js"></script>
  <script>
    const term = new Terminal({
      theme: {
        background: '#1a1a2e',
        foreground: '#e0e0e0',
        cursor: '#0af',
        selectionBackground: '#264f78',
      },
      fontFamily: "'JetBrains Mono', 'Fira Code', monospace",
      fontSize: 13,
      lineHeight: 1.2,
      cursorBlink: true,
      scrollback: 10000,
    });

    const fitAddon = new FitAddon.FitAddon();
    term.loadAddon(fitAddon);
    term.open(document.getElementById('terminal'));
    fitAddon.fit();

    term.writeln('\\x1b[36m>>> Connecting to 8gent agent...\\x1b[0m');
    term.writeln('');

    const dot = document.getElementById('statusDot');
    const clientEl = document.getElementById('clientCount');
    let reconnectDelay = 1000;

    function connect() {
      const protocol = location.protocol === 'https:' ? 'wss:' : 'ws:';
      const ws = new WebSocket(protocol + '//' + location.host + '/ws');

      ws.onopen = () => {
        dot.classList.remove('disconnected');
        term.writeln('\\x1b[32m>>> Connected\\x1b[0m');
        reconnectDelay = 1000;

        // Send periodic pings
        const pingInterval = setInterval(() => {
          if (ws.readyState === WebSocket.OPEN) {
            ws.send(JSON.stringify({ type: 'ping' }));
          } else {
            clearInterval(pingInterval);
          }
        }, 30000);
      };

      ws.onmessage = (e) => {
        try {
          const msg = JSON.parse(e.data);
          if (msg.type === 'output') {
            term.write(msg.data);
          } else if (msg.type === 'scrollback') {
            term.write(msg.data);
          } else if (msg.type === 'meta') {
            clientEl.textContent = msg.clients + ' viewer' + (msg.clients !== 1 ? 's' : '');
          } else if (msg.type === 'event') {
            term.writeln('\\x1b[33m[' + msg.event + ']\\x1b[0m ' + msg.detail);
          }
        } catch {
          term.write(e.data);
        }
      };

      ws.onclose = () => {
        dot.classList.add('disconnected');
        term.writeln('\\x1b[31m>>> Disconnected — reconnecting in ' + (reconnectDelay / 1000) + 's...\\x1b[0m');
        setTimeout(connect, reconnectDelay);
        reconnectDelay = Math.min(reconnectDelay * 2, 30000);
      };

      ws.onerror = () => {
        ws.close();
      };
    }

    connect();

    // Handle resize
    window.addEventListener('resize', () => fitAddon.fit());
  </script>
</body>
</html>`;
}

// ============================================
// Convenience singleton
// ============================================

let _instance: RemoteTerminalServer | null = null;

/** Get or create the singleton remote terminal server */
export function getRemoteTerminal(): RemoteTerminalServer {
  if (!_instance) {
    _instance = new RemoteTerminalServer();
  }
  return _instance;
}

/** Quick start — returns session info with URL */
export async function startRemoteTerminal(
  options?: RemoteTerminalOptions
): Promise<RemoteSession> {
  const server = getRemoteTerminal();
  if (server.isRunning()) {
    return server.getSession()!;
  }
  return server.start(options);
}

/** Stop the singleton */
export function stopRemoteTerminal(): void {
  if (_instance) {
    _instance.stop();
    _instance = null;
  }
}
