/**
 * Apple Foundation Model client.
 *
 * Spawns the `apple-foundation-bridge` Swift binary (built from
 * `bin/apple-foundation-bridge/`) as a long-lived subprocess and multiplexes
 * chat requests over stdin/stdout JSON-line IPC. macOS 26+ Apple Silicon only.
 *
 * v1: non-streaming, single-turn per request, no tool calling, no vision.
 */

import { existsSync } from "fs";
import { homedir } from "os";
import { join } from "path";
import { spawn } from "child_process";
import type { ChildProcessWithoutNullStreams } from "child_process";
import type { Message, MessageContent, LLMResponse, LLMClient } from "../types";

function flattenContent(content: MessageContent): string {
  if (typeof content === "string") return content;
  return content
    .map((part) => (part.type === "text" ? part.text ?? "" : ""))
    .join("");
}

interface BridgeRequest {
  messages: { role: string; content: string }[];
  model?: string;
  maxTokens?: number;
  temperature?: number;
}

interface BridgeResponse {
  model: string;
  message: { role: string; content: string };
  done: boolean;
  usage?: { prompt_tokens: number; completion_tokens: number; total_tokens: number };
  error?: string | null;
}

const DEFAULT_BRIDGE_PATH = join(homedir(), ".8gent", "bin", "apple-foundation-bridge");

export function resolveBridgePath(override?: string): string {
  if (override) return override;
  if (process.env.APPLE_FOUNDATION_BRIDGE) return process.env.APPLE_FOUNDATION_BRIDGE;
  return DEFAULT_BRIDGE_PATH;
}

export class AppleFoundationClient implements LLMClient {
  private model: string;
  private bridgePath: string;
  private proc: ChildProcessWithoutNullStreams | null = null;
  private queue: Array<{
    resolve: (value: BridgeResponse) => void;
    reject: (reason: unknown) => void;
  }> = [];
  private stdoutBuffer = "";

  constructor(model: string, bridgePath?: string) {
    this.model = model || "apple-foundationmodel";
    this.bridgePath = resolveBridgePath(bridgePath);
  }

  private ensureProcess(): ChildProcessWithoutNullStreams {
    if (this.proc && !this.proc.killed && this.proc.exitCode === null) {
      return this.proc;
    }

    if (!existsSync(this.bridgePath)) {
      throw new Error(
        `Apple Foundation bridge binary not found at ${this.bridgePath}. ` +
          `Run the installer (or \`swift build -c release\` inside ` +
          `bin/apple-foundation-bridge/ and copy the artifact to ~/.8gent/bin/).`,
      );
    }

    const proc = spawn(this.bridgePath, [], {
      stdio: ["pipe", "pipe", "pipe"],
    }) as ChildProcessWithoutNullStreams;

    proc.stdout.setEncoding("utf8");
    proc.stdout.on("data", (chunk: string) => this.onStdout(chunk));
    proc.stderr.setEncoding("utf8");
    proc.stderr.on("data", (chunk: string) => {
      if (process.env.DEBUG_APPLE_FOUNDATION) {
        process.stderr.write(`[apple-foundation-bridge] ${chunk}`);
      }
    });
    proc.on("exit", (code, signal) => {
      this.failPending(
        new Error(`apple-foundation-bridge exited (code=${code} signal=${signal})`),
      );
      this.proc = null;
    });

    this.proc = proc;
    return proc;
  }

  private onStdout(chunk: string) {
    this.stdoutBuffer += chunk;
    let newlineIndex = this.stdoutBuffer.indexOf("\n");
    while (newlineIndex !== -1) {
      const line = this.stdoutBuffer.slice(0, newlineIndex).trim();
      this.stdoutBuffer = this.stdoutBuffer.slice(newlineIndex + 1);
      if (line.length > 0) {
        this.deliver(line);
      }
      newlineIndex = this.stdoutBuffer.indexOf("\n");
    }
  }

  private deliver(line: string) {
    const pending = this.queue.shift();
    if (!pending) return;
    try {
      const parsed = JSON.parse(line) as BridgeResponse;
      pending.resolve(parsed);
    } catch (err) {
      pending.reject(new Error(`apple-foundation-bridge returned invalid JSON: ${line}`));
    }
  }

  private failPending(reason: Error) {
    const pending = this.queue.splice(0, this.queue.length);
    for (const p of pending) p.reject(reason);
  }

  private send(request: BridgeRequest): Promise<BridgeResponse> {
    const proc = this.ensureProcess();
    return new Promise((resolve, reject) => {
      this.queue.push({ resolve, reject });
      try {
        proc.stdin.write(JSON.stringify(request) + "\n");
      } catch (err) {
        this.queue.pop();
        reject(err);
      }
    });
  }

  async chat(messages: Message[], _tools?: object[]): Promise<LLMResponse> {
    const response = await this.send({
      messages: messages.map((m) => ({ role: m.role, content: flattenContent(m.content) })),
      model: this.model,
    });

    if (response.error) {
      throw new Error(`apple-foundation: ${response.error}`);
    }

    return {
      model: response.model,
      message: {
        role: response.message.role,
        content: response.message.content,
      },
      done: response.done,
      usage: response.usage,
    };
  }

  async generate(prompt: string): Promise<string> {
    const response = await this.chat([{ role: "user", content: prompt }]);
    return response.message.content;
  }

  async isAvailable(): Promise<boolean> {
    if (process.platform !== "darwin") return false;
    if (process.arch !== "arm64") return false;
    if (!existsSync(this.bridgePath)) return false;
    return true;
  }

  dispose(): void {
    if (this.proc && !this.proc.killed) {
      this.proc.stdin.end();
      this.proc.kill("SIGTERM");
    }
    this.proc = null;
    this.failPending(new Error("client disposed"));
  }
}
