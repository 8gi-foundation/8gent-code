/**
 * CostTracker - tracks API token usage and estimates costs across model providers.
 * Self-contained, zero external dependencies.
 */

export interface ModelPricing {
  id: string;
  name: string;
  provider: string;
  inputPer1k: number;
  outputPer1k: number;
}

export interface RequestRecord {
  id: string;
  model: string;
  inputTokens: number;
  outputTokens: number;
  inputCostUsd: number;
  outputCostUsd: number;
  totalCostUsd: number;
  timestamp: number;
  label?: string;
}

export interface CostReport {
  totalRequests: number;
  totalInputTokens: number;
  totalOutputTokens: number;
  totalTokens: number;
  totalCostUsd: number;
  byModel: Record<string, ModelSummary>;
}

export interface ModelSummary {
  requests: number;
  inputTokens: number;
  outputTokens: number;
  costUsd: number;
}

// Pricing table - approximate as of early 2026. Verify before billing.
export const PRICING: ModelPricing[] = [
  { id: "claude-3-5-sonnet",  name: "Claude 3.5 Sonnet",   provider: "anthropic",  inputPer1k: 0.003,   outputPer1k: 0.015   },
  { id: "claude-3-haiku",     name: "Claude 3 Haiku",      provider: "anthropic",  inputPer1k: 0.00025, outputPer1k: 0.00125 },
  { id: "claude-opus-4",      name: "Claude Opus 4",       provider: "anthropic",  inputPer1k: 0.015,   outputPer1k: 0.075   },
  { id: "gpt-4o",             name: "GPT-4o",              provider: "openai",     inputPer1k: 0.0025,  outputPer1k: 0.01    },
  { id: "gpt-4o-mini",        name: "GPT-4o Mini",         provider: "openai",     inputPer1k: 0.00015, outputPer1k: 0.0006  },
  { id: "o1",                 name: "OpenAI o1",           provider: "openai",     inputPer1k: 0.015,   outputPer1k: 0.06    },
  { id: "gemini-2.0-flash",   name: "Gemini 2.0 Flash",    provider: "google",     inputPer1k: 0.0001,  outputPer1k: 0.0004  },
  { id: "gemini-2.0-pro",     name: "Gemini 2.0 Pro",      provider: "google",     inputPer1k: 0.0035,  outputPer1k: 0.014   },
  { id: "llama-3-70b",        name: "Llama 3 70B",         provider: "openrouter", inputPer1k: 0,       outputPer1k: 0       },
  { id: "qwen-local",         name: "Qwen (local/Ollama)", provider: "ollama",     inputPer1k: 0,       outputPer1k: 0       },
];

function findPricing(modelId: string): ModelPricing | undefined {
  const normalized = modelId.toLowerCase();
  return PRICING.find(
    (p) => normalized.includes(p.id) || p.id.includes(normalized)
  );
}

function calcCost(p: ModelPricing, input: number, output: number) {
  const inputCostUsd = (input / 1000) * p.inputPer1k;
  const outputCostUsd = (output / 1000) * p.outputPer1k;
  return { inputCostUsd, outputCostUsd, totalCostUsd: inputCostUsd + outputCostUsd };
}

export class CostTracker {
  private records: RequestRecord[] = [];
  private counter = 0;

  track(opts: { model: string; inputTokens: number; outputTokens: number; label?: string }): RequestRecord {
    const pricing = findPricing(opts.model);
    const costs = pricing
      ? calcCost(pricing, opts.inputTokens, opts.outputTokens)
      : { inputCostUsd: 0, outputCostUsd: 0, totalCostUsd: 0 };

    const record: RequestRecord = {
      id: `req-${++this.counter}`,
      model: opts.model,
      inputTokens: opts.inputTokens,
      outputTokens: opts.outputTokens,
      ...costs,
      timestamp: Date.now(),
      label: opts.label,
    };
    this.records.push(record);
    return record;
  }

  totalCost(): number {
    return this.records.reduce((sum, r) => sum + r.totalCostUsd, 0);
  }

  history(): RequestRecord[] {
    return [...this.records];
  }

  reset(): void {
    this.records = [];
    this.counter = 0;
  }

  report(): CostReport {
    const byModel: Record<string, ModelSummary> = {};
    for (const r of this.records) {
      if (!byModel[r.model]) byModel[r.model] = { requests: 0, inputTokens: 0, outputTokens: 0, costUsd: 0 };
      const m = byModel[r.model];
      m.requests++;
      m.inputTokens += r.inputTokens;
      m.outputTokens += r.outputTokens;
      m.costUsd += r.totalCostUsd;
    }
    const totalInputTokens = this.records.reduce((s, r) => s + r.inputTokens, 0);
    const totalOutputTokens = this.records.reduce((s, r) => s + r.outputTokens, 0);
    return {
      totalRequests: this.records.length,
      totalInputTokens,
      totalOutputTokens,
      totalTokens: totalInputTokens + totalOutputTokens,
      totalCostUsd: this.totalCost(),
      byModel,
    };
  }

  reportText(): string {
    const r = this.report();
    const fmt = (n: number) => `$${n.toFixed(6)}`;
    const lines = [
      `=== Cost Report ===`,
      `Requests:     ${r.totalRequests}`,
      `Total tokens: ${r.totalTokens.toLocaleString()} (in: ${r.totalInputTokens.toLocaleString()}, out: ${r.totalOutputTokens.toLocaleString()})`,
      `Total cost:   ${fmt(r.totalCostUsd)}`,
      ``,
      `By model:`,
      ...Object.entries(r.byModel).map(
        ([model, m]) => `  ${model}: ${m.requests} reqs, ${m.inputTokens + m.outputTokens} tokens, ${fmt(m.costUsd)}`
      ),
    ];
    return lines.join("\n");
  }
}

export const globalTracker = new CostTracker();

if (import.meta.main) {
  const t = new CostTracker();
  t.track({ model: "claude-3-5-sonnet", inputTokens: 1000, outputTokens: 500 });
  t.track({ model: "gpt-4o",            inputTokens: 2000, outputTokens: 800 });
  t.track({ model: "qwen-local",         inputTokens: 500,  outputTokens: 200 });
  console.log(t.reportText());
}
