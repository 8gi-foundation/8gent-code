/**
 * Phase 1: Training Proxy Manager
 *
 * Manages the RL training proxy lifecycle:
 * - Start/stop the proxy process
 * - Health checks with latency monitoring
 * - Transparent passthrough validation (no latency regression)
 * - Conversation trace collection status
 */

import { spawn, type Subprocess } from "bun";
import { readFileSync, existsSync } from "node:fs";
import { resolve } from "node:path";

export interface ProxyConfig {
  /** Training proxy port (default: 30000) */
  port: number;
  /** Upstream Ollama URL (default: http://localhost:11434) */
  ollamaUrl: string;
  /** Path to training-proxy.yaml config */
  configPath: string;
  /** Mode: skills_only (phase 1), rl (phase 3), madmax (phase 4) */
  mode: "skills_only" | "rl" | "madmax";
  /** Max acceptable latency overhead in ms (default: 200) */
  maxLatencyOverheadMs: number;
}

export interface ProxyStatus {
  running: boolean;
  url: string;
  mode: string;
  uptime: number;
  latency: LatencySnapshot | null;
  ollamaReachable: boolean;
}

interface LatencySnapshot {
  directMs: number;
  proxiedMs: number;
  overheadMs: number;
  timestamp: number;
}

const DEFAULT_CONFIG: ProxyConfig = {
  port: 30000,
  ollamaUrl: "http://localhost:11434",
  configPath: "config/training-proxy.yaml",
  mode: "skills_only",
  maxLatencyOverheadMs: 200,
};

export class TrainingProxy {
  private config: ProxyConfig;
  private process: Subprocess | null = null;
  private startedAt: number = 0;
  private latencyHistory: LatencySnapshot[] = [];

  constructor(config: Partial<ProxyConfig> = {}) {
    this.config = { ...DEFAULT_CONFIG, ...config };
  }

  get url(): string {
    return `http://localhost:${this.config.port}`;
  }

  /**
   * Start the Training proxy process.
   */
  async start(): Promise<void> {
    if (this.process) {
      throw new Error("Training proxy is already running");
    }

    // Verify Ollama is reachable first
    const ollamaUp = await this.checkEndpoint(this.config.ollamaUrl + "/api/tags");
    if (!ollamaUp) {
      throw new Error(`Ollama not reachable at ${this.config.ollamaUrl}`);
    }

    const configPath = resolve(this.config.configPath);
    if (!existsSync(configPath)) {
      throw new Error(`Training proxy config not found at ${configPath}`);
    }

    this.process = spawn({
      cmd: ["metaclaw", "start", "--mode", this.config.mode, "--config", configPath],
      stdout: "pipe",
      stderr: "pipe",
    });

    this.startedAt = Date.now();

    // Wait for proxy to become healthy
    const healthy = await this.waitForHealth(15_000);
    if (!healthy) {
      await this.stop();
      throw new Error("Training proxy failed to start within 15s");
    }
  }

  /**
   * Stop the Training proxy process.
   */
  async stop(): Promise<void> {
    if (this.process) {
      this.process.kill();
      this.process = null;
      this.startedAt = 0;
    }
    // Also try the CLI stop command in case it was started externally
    try {
      const proc = spawn({ cmd: ["metaclaw", "stop"], stdout: "pipe", stderr: "pipe" });
      await proc.exited;
    } catch {
      // Ignore — may not be installed or already stopped
    }
  }

  /**
   * Check if the proxy is running and healthy.
   */
  async isHealthy(): Promise<boolean> {
    return this.checkEndpoint(`${this.url}/api/tags`);
  }

  /**
   * Get full proxy status including latency measurements.
   */
  async getStatus(): Promise<ProxyStatus> {
    const running = await this.isHealthy();
    const ollamaReachable = await this.checkEndpoint(this.config.ollamaUrl + "/api/tags");

    let latency: LatencySnapshot | null = null;
    if (running && ollamaReachable) {
      latency = await this.measureLatency();
    }

    return {
      running,
      url: this.url,
      mode: this.config.mode,
      uptime: this.startedAt > 0 ? Date.now() - this.startedAt : 0,
      latency,
      ollamaReachable,
    };
  }

  /**
   * Measure latency overhead: direct Ollama vs through proxy.
   */
  async measureLatency(): Promise<LatencySnapshot> {
    const testPayload = JSON.stringify({
      model: "qwen3:14b",
      messages: [{ role: "user", content: "Say hi" }],
      stream: false,
    });

    const directMs = await this.timeRequest(
      `${this.config.ollamaUrl}/api/chat`,
      testPayload
    );

    const proxiedMs = await this.timeRequest(
      `${this.url}/api/chat`,
      testPayload
    );

    const snapshot: LatencySnapshot = {
      directMs,
      proxiedMs,
      overheadMs: proxiedMs - directMs,
      timestamp: Date.now(),
    };

    this.latencyHistory.push(snapshot);
    // Keep last 50 measurements
    if (this.latencyHistory.length > 50) {
      this.latencyHistory = this.latencyHistory.slice(-50);
    }

    return snapshot;
  }

  /**
   * Check if proxy latency overhead is within acceptable bounds.
   */
  isLatencyAcceptable(): boolean {
    if (this.latencyHistory.length === 0) return true;
    const recent = this.latencyHistory.slice(-5);
    const avgOverhead = recent.reduce((s, l) => s + l.overheadMs, 0) / recent.length;
    return avgOverhead <= this.config.maxLatencyOverheadMs;
  }

  /**
   * Get latency statistics.
   */
  getLatencyStats(): { avg: number; min: number; max: number; samples: number } {
    if (this.latencyHistory.length === 0) {
      return { avg: 0, min: 0, max: 0, samples: 0 };
    }
    const overheads = this.latencyHistory.map((l) => l.overheadMs);
    return {
      avg: Math.round(overheads.reduce((a, b) => a + b, 0) / overheads.length),
      min: Math.min(...overheads),
      max: Math.max(...overheads),
      samples: overheads.length,
    };
  }

  // ── Private helpers ────────────────────────────────────────────────

  private async checkEndpoint(url: string): Promise<boolean> {
    try {
      const res = await fetch(url, { signal: AbortSignal.timeout(5000) });
      return res.ok;
    } catch {
      return false;
    }
  }

  private async waitForHealth(timeoutMs: number): Promise<boolean> {
    const start = Date.now();
    while (Date.now() - start < timeoutMs) {
      if (await this.isHealthy()) return true;
      await Bun.sleep(500);
    }
    return false;
  }

  private async timeRequest(url: string, body: string): Promise<number> {
    const start = performance.now();
    try {
      await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body,
        signal: AbortSignal.timeout(30_000),
      });
    } catch {
      // Timeout or error — return a large value
      return 30_000;
    }
    return Math.round(performance.now() - start);
  }
}
