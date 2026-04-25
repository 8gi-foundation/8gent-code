/**
 * 8gent Code - Model Failover Chains
 *
 * When a model is down, resolve to the next healthy model in the chain.
 * Chains stored in ~/.8gent/failover.json.
 *
 * Channel-aware: the `text` channel uses the legacy chain anchored on the
 * existing local default. The `computer` channel uses the chain built for
 * the 8gent Computer surface: apfel (chat) → Qwen 3.6-27B (vision/tool)
 * → DeepSeek V4-Flash (heavy cloud) → OpenRouter `:free` (last resort).
 */

import { readFileSync, existsSync } from "fs";
import { join } from "path";
import { homedir, release } from "os";

/**
 * Apple Foundation Model is preferred at the top of every local chain when
 * the host qualifies (macOS 26+ Tahoe on Apple Silicon with the bridge binary
 * installed). On-device, zero latency, zero cost, zero telemetry.
 */
function appleFoundationAvailable(): boolean {
  if (process.platform !== "darwin") return false;
  if (process.arch !== "arm64") return false;
  const major = parseInt(release().split(".")[0] ?? "0", 10);
  if (Number.isFinite(major) && major < 25) return false;
  return existsSync(join(homedir(), ".8gent", "bin", "apple-foundation-bridge"));
}

const APPLE_FOUNDATION_ENTRY: FailoverEntry = {
  model: "apple-foundationmodel",
  provider: "apple-foundation",
};

const APFEL_ENTRY: FailoverEntry = {
  model: "apple-foundationmodel",
  provider: "apfel",
};

export type FailoverChannel = "text" | "computer";

export interface FailoverEntry {
  model: string;
  provider: string;
}

export interface FailoverChain {
  models: FailoverEntry[];
}

export interface FailoverEvent {
  ts: number;
  channel: FailoverChannel;
  fromModel: string;
  fromProvider: string;
  toModel: string;
  toProvider: string;
  reason: string;
}

export class ModelFailover {
  private chainsByChannel: Record<FailoverChannel, Record<string, FailoverChain>>;
  private down: Set<string> = new Set();
  private events: FailoverEvent[] = [];

  constructor(chains?: Record<FailoverChannel, Record<string, FailoverChain>>) {
    this.chainsByChannel = chains || this.loadChains();
  }

  private loadChains(): Record<FailoverChannel, Record<string, FailoverChain>> {
    try {
      const fp = join(homedir(), ".8gent", "failover.json");
      if (existsSync(fp)) {
        const raw = JSON.parse(readFileSync(fp, "utf-8"));
        // Back-compat: if the file is the old flat shape (no `text`/`computer`
        // top-level keys), treat the whole thing as the text channel.
        if (raw && typeof raw === "object" && !raw.text && !raw.computer) {
          return { text: raw, computer: this.defaultComputerChains() };
        }
        return {
          text: raw.text || this.defaultTextChains(),
          computer: raw.computer || this.defaultComputerChains(),
        };
      }
    } catch {
      // Fall through to defaults.
    }

    return {
      text: this.defaultTextChains(),
      computer: this.defaultComputerChains(),
    };
  }

  private defaultTextChains(): Record<string, FailoverChain> {
    const preferAppleFoundation = appleFoundationAvailable();
    const prefix: FailoverEntry[] = preferAppleFoundation ? [APPLE_FOUNDATION_ENTRY] : [];

    return {
      "eight:latest": {
        models: [
          ...prefix,
          { model: "eight:latest", provider: "ollama" },
          { model: "qwen3.5:latest", provider: "ollama" },
          { model: "meta-llama/llama-3-8b-instruct:free", provider: "openrouter" },
        ],
      },
      "qwen3.5:latest": {
        models: [
          ...prefix,
          { model: "qwen3.5:latest", provider: "ollama" },
          { model: "meta-llama/llama-3-8b-instruct:free", provider: "openrouter" },
        ],
      },
      "apple-foundationmodel": {
        models: [
          APPLE_FOUNDATION_ENTRY,
          { model: "eight-1.0-q3:14b", provider: "8gent" },
          { model: "qwen3:14b", provider: "ollama" },
          { model: "meta-llama/llama-3-8b-instruct:free", provider: "openrouter" },
        ],
      },
    };
  }

  /**
   * Computer channel chain: apfel (chat) → Qwen 3.6-27B (vision/tool, default
   * brain) → DeepSeek V4-Flash (heavy cloud) → OpenRouter `:free` (last resort).
   *
   * Apfel handles short conversational replies (no vision). The agent is
   * responsible for routing vision-bearing prompts past the chat tier (see
   * `vision-router.ts`. If apfel is asked for a vision prompt, it will throw
   * and the chain falls through to Qwen.
   */
  private defaultComputerChains(): Record<string, FailoverChain> {
    const computerChain: FailoverEntry[] = [
      APFEL_ENTRY,
      { model: "qwen3.6:27b", provider: "ollama" },
      { model: "deepseek-v4-flash", provider: "deepseek" },
      { model: "meta-llama/llama-3-8b-instruct:free", provider: "openrouter" },
    ];

    return {
      "qwen3.6:27b": { models: computerChain },
      "apple-foundationmodel": { models: computerChain },
      "deepseek-v4-flash": {
        models: [
          { model: "deepseek-v4-flash", provider: "deepseek" },
          { model: "qwen3.6:27b", provider: "ollama" },
          { model: "meta-llama/llama-3-8b-instruct:free", provider: "openrouter" },
        ],
      },
    };
  }

  private key(model: string, provider: string): string {
    return `${provider}::${model}`;
  }

  /**
   * Return the first healthy model in the chain for the given channel.
   * Defaults to the `text` channel for back-compat with existing callers.
   */
  resolve(model: string, channel: FailoverChannel = "text"): FailoverEntry {
    const chain = this.chainsByChannel[channel]?.[model];
    if (!chain) return { model, provider: "ollama" };

    const head = chain.models[0];
    for (const entry of chain.models) {
      if (!this.down.has(this.key(entry.model, entry.provider))) {
        if (head && (entry.model !== head.model || entry.provider !== head.provider)) {
          this.recordEvent({
            ts: Date.now(),
            channel,
            fromModel: head.model,
            fromProvider: head.provider,
            toModel: entry.model,
            toProvider: entry.provider,
            reason: "primary-down",
          });
        }
        return entry;
      }
    }

    // Everything is down - return last entry as a hail mary
    const last = chain.models[chain.models.length - 1] || { model, provider: "ollama" };
    this.recordEvent({
      ts: Date.now(),
      channel,
      fromModel: head?.model ?? model,
      fromProvider: head?.provider ?? "ollama",
      toModel: last.model,
      toProvider: last.provider,
      reason: "all-tiers-down",
    });
    return last;
  }

  markDown(model: string, provider: string): void {
    this.down.add(this.key(model, provider));
  }

  markUp(model: string, provider: string): void {
    this.down.delete(this.key(model, provider));
  }

  isDown(model: string, provider: string): boolean {
    return this.down.has(this.key(model, provider));
  }

  /** Recent failover events. Drained by the bake-off harness. */
  getEvents(): FailoverEvent[] {
    return [...this.events];
  }

  drainEvents(): FailoverEvent[] {
    const out = [...this.events];
    this.events = [];
    return out;
  }

  private recordEvent(event: FailoverEvent): void {
    this.events.push(event);
    if (process.env.FAILOVER_LOG === "1") {
      // Keep the line machine-parseable for the bake-off harness.
      process.stderr.write(`[failover] ${JSON.stringify(event)}\n`);
    }
  }
}
