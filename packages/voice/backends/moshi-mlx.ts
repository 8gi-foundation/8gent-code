/**
 * MoshiMLXProvider — full-duplex voice via Moshi (Kyutai) on Apple Silicon
 *
 * Moshi: https://github.com/kyutai-labs/moshi
 * Install: pip install moshi
 * Device: --device mps on Apple Silicon (Metal Performance Shaders), --device cpu elsewhere
 * Cost: $0, MIT license, ~200ms latency on MPS
 *
 * Note: moshi 0.2.13 uses PyTorch (not MLX). The [mlx] extra does not exist in this version.
 * Uses --device mps (Apple Metal) on arm64 Darwin for GPU acceleration.
 *
 * Architecture:
 * - Spawns a Python subprocess running Moshi's WebSocket server on localhost:8998
 * - Streams audio in/out simultaneously over the WebSocket
 * - Subprocess is started lazily on first stream() call, killed on stopServer()
 */

import { execSync, spawn, type ChildProcess } from "child_process";
import type WS from "ws";
import type { FullDuplexProvider, VoiceBackend } from "../full-duplex-provider";
import { MOSHI_HF_REPO } from "../full-duplex-provider";

const MOSHI_WS_PORT = 8998;
const MOSHI_WS_URL = `ws://localhost:${MOSHI_WS_PORT}`;
const MOSHI_STARTUP_TIMEOUT_MS = 30_000;

export class MoshiMLXProvider implements FullDuplexProvider {
  readonly name: VoiceBackend = "moshi-mlx";
  private _process: ChildProcess | null = null;
  private _personaPrompt: string | undefined;

  async isAvailable(): Promise<boolean> {
    // Must be Apple Silicon Mac
    if (process.platform !== "darwin" || process.arch !== "arm64") return false;
    // Moshi Python package must be installed
    try {
      execSync("python3 -c \"import moshi\"", { stdio: "ignore", timeout: 5000 });
      return true;
    } catch {
      return false;
    }
  }

  async setPersona(textPrompt: string): Promise<void> {
    this._personaPrompt = textPrompt;
  }

  async *stream(audioIn: AsyncIterable<Buffer>): AsyncIterable<Buffer> {
    await this._ensureServer();

    // Note: Full WebSocket streaming implementation.
    // We use a simple duplex loop: send audio frames in, yield audio frames out.
    // In production this would use the 'ws' package; here we use a subprocess pipe
    // for compatibility with the existing bun environment.

    const { default: WebSocket } = await import("ws").catch(() => {
      throw new Error(
        "WebSocket package not found. Run: bun add ws\n" +
        "Or install moshi: pip install moshi"
      );
    });

    const ws = new WebSocket(MOSHI_WS_URL);

    yield* this._duplexStream(ws, audioIn);
    ws.close();
  }

  private async *_duplexStream(
    ws: WS,
    audioIn: AsyncIterable<Buffer>
  ): AsyncIterable<Buffer> {
    const outputQueue: Buffer[] = [];
    let done = false;

    ws.on("message", (data: Buffer) => {
      outputQueue.push(data);
    });

    ws.on("close", () => { done = true; });
    ws.on("error", () => { done = true; });

    // Wait for connection
    await new Promise<void>((resolve, reject) => {
      ws.on("open", resolve);
      ws.on("error", reject);
      setTimeout(() => reject(new Error("Moshi WebSocket connection timeout")), 5000);
    });

    // Send persona prompt if set
    if (this._personaPrompt) {
      ws.send(JSON.stringify({ type: "persona", text: this._personaPrompt }));
    }

    // Stream input while yielding output
    for await (const chunk of audioIn) {
      ws.send(chunk);
      // Yield any buffered output
      while (outputQueue.length > 0) {
        yield outputQueue.shift()!;
      }
    }

    // Drain remaining output
    while (!done || outputQueue.length > 0) {
      if (outputQueue.length > 0) {
        yield outputQueue.shift()!;
      } else {
        await new Promise(r => setTimeout(r, 10));
      }
    }
  }

  private async _ensureServer(): Promise<void> {
    if (this._process && !this._process.killed) return;

    // Use MPS (Apple Metal) on Apple Silicon for GPU acceleration, CPU elsewhere
    const device = process.platform === "darwin" && process.arch === "arm64" ? "mps" : "cpu";

    this._process = spawn("python3", [
      "-m", "moshi.server",
      "--port", String(MOSHI_WS_PORT),
      "--device", device,
      "--hf-repo", MOSHI_HF_REPO,
    ], {
      stdio: ["ignore", "pipe", "pipe"],
      detached: false,
    });

    this._process.on("exit", () => { this._process = null; });

    // Wait for server to be ready (listen for port open)
    await this._waitForPort(MOSHI_WS_PORT, MOSHI_STARTUP_TIMEOUT_MS);
  }

  async stopServer(): Promise<void> {
    if (this._process && !this._process.killed) {
      this._process.kill("SIGTERM");
      this._process = null;
    }
  }

  private async _waitForPort(port: number, timeoutMs: number): Promise<void> {
    const start = Date.now();
    while (Date.now() - start < timeoutMs) {
      try {
        execSync(`nc -z localhost ${port}`, { stdio: "ignore", timeout: 500 });
        return; // Port is open
      } catch {
        await new Promise(r => setTimeout(r, 500));
      }
    }
    throw new Error(
      `Moshi server did not start within ${timeoutMs / 1000}s on port ${port}.\n` +
      "Make sure moshi is installed: pip install moshi"
    );
  }
}
