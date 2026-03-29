/**
 * 8gent Code - Model Failover Chains
 *
 * When a model is down, resolve to the next healthy model in the chain.
 * Chains stored in ~/.8gent/failover.json.
 */

import { readFileSync, existsSync } from "fs";
import { join } from "path";
import { homedir } from "os";

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

    // Sensible defaults - free OpenRouter as fallback for local models
    return {
      "eight:latest": {
        models: [
          { model: "eight:latest", provider: "ollama" },
          { model: "qwen3.5:latest", provider: "ollama" },
          { model: "meta-llama/llama-3-8b-instruct:free", provider: "openrouter" },
        ],
      },
      "qwen3.5:latest": {
        models: [
          { model: "qwen3.5:latest", provider: "ollama" },
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
