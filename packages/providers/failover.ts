/**
 * 8gent Code - Model Failover Chains
 *
 * When a model is down, resolve to the next healthy model in the chain.
 * Chains stored in ~/.8gent/failover.json.
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
  model: "apple-foundation-system",
  provider: "apple-foundation",
};

export interface FailoverEntry {
  model: string;
  provider: string;
}

export interface FailoverChain {
  models: FailoverEntry[];
}

export class ModelFailover {
  private chains: Record<string, FailoverChain>;
  private down: Set<string> = new Set();

  constructor(chains?: Record<string, FailoverChain>) {
    this.chains = chains || this.loadChains();
  }

  private loadChains(): Record<string, FailoverChain> {
    try {
      const fp = join(homedir(), ".8gent", "failover.json");
      if (existsSync(fp)) {
        return JSON.parse(readFileSync(fp, "utf-8"));
      }
    } catch { /* defaults */ }

    const preferAppleFoundation = appleFoundationAvailable();
    const prefix: FailoverEntry[] = preferAppleFoundation ? [APPLE_FOUNDATION_ENTRY] : [];

    // Sensible defaults - free OpenRouter as fallback for local models
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
      "apple-foundation-system": {
        models: [
          APPLE_FOUNDATION_ENTRY,
          { model: "eight-1.0-q3:14b", provider: "8gent" },
          { model: "qwen3:14b", provider: "ollama" },
          { model: "meta-llama/llama-3-8b-instruct:free", provider: "openrouter" },
        ],
      },
    };
  }

  private key(model: string, provider: string): string {
    return `${provider}::${model}`;
  }

  /** Return the first healthy model in the chain, or the original if no chain exists. */
  resolve(model: string): FailoverEntry {
    const chain = this.chains[model];
    if (!chain) return { model, provider: "ollama" };

    for (const entry of chain.models) {
      if (!this.down.has(this.key(entry.model, entry.provider))) {
        return entry;
      }
    }

    // Everything is down - return last entry as a hail mary
    return chain.models[chain.models.length - 1] || { model, provider: "ollama" };
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
}
