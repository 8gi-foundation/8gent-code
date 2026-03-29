/**
 * 8gent Code - JSON-RPC 2.0 Server
 * Headless mode for CI/IDE integration. Newline-delimited JSON on stdin/stdout.
 * Spawn with: 8gent rpc | 8gent --rpc
 */
import { Agent } from "./agent";
import { TOOL_CATEGORIES } from "./tool-registry";
import type { RPCRequest, RPCResponse, RPCNotification } from "./rpc-types";
import { RPC_ERRORS } from "./rpc-types";
import type { AgentEventCallbacks } from "./types";
import * as readline from "readline";

const sessions = new Map<string, { agent: Agent; id: string }>();

function send(msg: RPCResponse | RPCNotification): void {
  process.stdout.write(JSON.stringify(msg) + "\n");
}
function sendResult(id: number | string, result: unknown): void {
  send({ jsonrpc: "2.0", id, result });
}
function sendError(id: number | string, code: number, message: string, data?: unknown): void {
  send({ jsonrpc: "2.0", id, error: { code, message, data } });
}
function notify(method: string, params: Record<string, unknown>): void {
  send({ jsonrpc: "2.0", method, params });
}

// ── Method dispatch ───────────────────────────────────────────────

type Handler = (id: number | string, params: Record<string, unknown>) => Promise<void>;

const methods: Record<string, Handler> = {
  "session.create": async (id, params) => {
    const model = (params.model as string) || "qwen3.5:latest";
    const cwd = (params.cwd as string) || process.cwd();
    const sessionId = `rpc_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;

    const events: AgentEventCallbacks = {
      onToolStart: (e) => notify("stream.toolCall", { sessionId, tool: e.toolName, args: e.args }),
      onToolEnd: (e) => notify("stream.toolResult", { sessionId, tool: e.toolName, result: e.resultPreview }),
      onStepFinish: (e) => {
        if (e.text) notify("stream.token", { sessionId, token: e.text });
      },
    };

    const agent = new Agent({
      model,
      runtime: "ollama",
      workingDirectory: cwd,
      maxTurns: 30,
      events,
    });

    sessions.set(sessionId, { agent, id: sessionId });
    sendResult(id, { sessionId });
  },

  "session.message": async (id, params) => {
    const sessionId = params.sessionId as string;
    const content = params.content as string;

    if (!sessionId || !content) {
      return sendError(id, RPC_ERRORS.INVALID_PARAMS, "sessionId and content required");
    }

    const session = sessions.get(sessionId);
    if (!session) {
      return sendError(id, RPC_ERRORS.INVALID_PARAMS, `Unknown session: ${sessionId}`);
    }

    try {
      const response = await session.agent.chat(content);
      notify("stream.done", { sessionId });
      sendResult(id, { response, usage: {} });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      notify("stream.error", { sessionId, error: msg });
      sendError(id, RPC_ERRORS.INTERNAL_ERROR, msg);
    }
  },

  "session.abort": async (id, params) => {
    const sessionId = params.sessionId as string;
    const session = sessions.get(sessionId);
    if (!session) {
      return sendError(id, RPC_ERRORS.INVALID_PARAMS, `Unknown session: ${sessionId}`);
    }
    session.agent.abort();
    sendResult(id, { ok: true });
  },

  "session.destroy": async (id, params) => {
    const sessionId = params.sessionId as string;
    const session = sessions.get(sessionId);
    if (!session) {
      return sendError(id, RPC_ERRORS.INVALID_PARAMS, `Unknown session: ${sessionId}`);
    }
    await session.agent.cleanup();
    sessions.delete(sessionId);
    sendResult(id, { ok: true });
  },

  "tools.list": async (id) => {
    const tools = Object.entries(TOOL_CATEGORIES).flatMap(([category, names]) =>
      names.map((name) => ({ name, category }))
    );
    sendResult(id, { tools });
  },
};

// ── Request handler ───────────────────────────────────────────────

async function handleLine(line: string): Promise<void> {
  let parsed: RPCRequest;
  try {
    parsed = JSON.parse(line);
  } catch {
    return sendError(0, RPC_ERRORS.PARSE_ERROR, "Invalid JSON");
  }

  if (parsed.jsonrpc !== "2.0" || !parsed.method || parsed.id == null) {
    return sendError(parsed.id ?? 0, RPC_ERRORS.INVALID_REQUEST, "Invalid JSON-RPC 2.0 request");
  }

  const handler = methods[parsed.method];
  if (!handler) {
    return sendError(parsed.id, RPC_ERRORS.METHOD_NOT_FOUND, `Unknown method: ${parsed.method}`);
  }

  try {
    await handler(parsed.id, parsed.params || {});
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    sendError(parsed.id, RPC_ERRORS.INTERNAL_ERROR, msg);
  }
}

// ── Main loop ─────────────────────────────────────────────────────

export async function startRPCServer(): Promise<void> {
  // Redirect console to stderr so stdout stays clean for JSON-RPC
  const stderrWrite = (data: string) => process.stderr.write(data + "\n");
  console.log = stderrWrite;
  console.info = stderrWrite;
  console.warn = stderrWrite;
  console.debug = stderrWrite;
  // Keep console.error on stderr (already there)

  process.stderr.write("[8gent-rpc] Server ready. Waiting for JSON-RPC requests on stdin.\n");

  const rl = readline.createInterface({ input: process.stdin, terminal: false });

  rl.on("line", (line: string) => {
    const trimmed = line.trim();
    if (!trimmed) return;
    handleLine(trimmed).catch((err) => {
      process.stderr.write(`[8gent-rpc] Unhandled error: ${err}\n`);
    });
  });

  rl.on("close", async () => {
    // Clean up all sessions on stdin close
    const ids = Array.from(sessions.keys());
    for (const sid of ids) {
      await sessions.get(sid)?.agent.cleanup().catch(() => {});
    }
    process.exit(0);
  });
}
