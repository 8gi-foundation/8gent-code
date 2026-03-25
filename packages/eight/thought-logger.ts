export type ThoughtCategory = "PLAN" | "REASON" | "DECIDE" | "ACT" | "OBSERVE" | "REFLECT";

export interface ThoughtEntry {
  id: string;
  category: ThoughtCategory;
  content: string;
  timestamp: number;
  chainId: string;
  parentId: string | null;
  depth: number;
  metadata?: Record<string, unknown>;
}

export interface ThoughtChain {
  id: string;
  label: string;
  parentChainId: string | null;
  entries: ThoughtEntry[];
  startedAt: number;
  finishedAt: number | null;
}

export interface ThoughtTimeline {
  chains: ThoughtChain[];
  entries: ThoughtEntry[];
  startedAt: number;
  finishedAt: number | null;
  durationMs: number | null;
}

let _seq = 0;
function nextId(prefix: string): string {
  return `${prefix}-${Date.now()}-${++_seq}`;
}

export class ThoughtLogger {
  private chains: Map<string, ThoughtChain> = new Map();
  private entries: ThoughtEntry[] = [];
  private activeChainId: string | null = null;
  private startedAt: number = Date.now();
  private finishedAt: number | null = null;

  startChain(label: string, parentChainId?: string): string {
    const id = nextId("chain");
    const chain: ThoughtChain = {
      id, label,
      parentChainId: parentChainId ?? this.activeChainId ?? null,
      entries: [], startedAt: Date.now(), finishedAt: null,
    };
    this.chains.set(id, chain);
    this.activeChainId = id;
    return id;
  }

  endChain(chainId?: string): void {
    const id = chainId ?? this.activeChainId;
    if (!id) return;
    const chain = this.chains.get(id);
    if (chain) chain.finishedAt = Date.now();
    if (this.activeChainId === id) this.activeChainId = chain?.parentChainId ?? null;
  }

  async withinChain<T>(label: string, fn: (id: string) => Promise<T>, parentChainId?: string): Promise<T> {
    const id = this.startChain(label, parentChainId);
    try { return await fn(id); } finally { this.endChain(id); }
  }

  withinChainSync<T>(label: string, fn: (id: string) => T, parentChainId?: string): T {
    const id = this.startChain(label, parentChainId);
    try { return fn(id); } finally { this.endChain(id); }
  }

  log(
    category: ThoughtCategory,
    content: string,
    opts: { chainId?: string; parentId?: string; metadata?: Record<string, unknown> } = {}
  ): string {
    const chainId = opts.chainId ?? this.activeChainId ?? this._defaultChain();
    const chain = this.chains.get(chainId);
    const entry: ThoughtEntry = {
      id: nextId("thought"), category, content,
      timestamp: Date.now(), chainId,
      parentId: opts.parentId ?? null,
      depth: this._chainDepth(chainId),
      metadata: opts.metadata,
    };
    this.entries.push(entry);
    chain?.entries.push(entry);
    return entry.id;
  }

  plan(c: string, o?: Parameters<ThoughtLogger["log"]>[2]) { return this.log("PLAN", c, o); }
  reason(c: string, o?: Parameters<ThoughtLogger["log"]>[2]) { return this.log("REASON", c, o); }
  decide(c: string, o?: Parameters<ThoughtLogger["log"]>[2]) { return this.log("DECIDE", c, o); }
  act(c: string, o?: Parameters<ThoughtLogger["log"]>[2]) { return this.log("ACT", c, o); }
  observe(c: string, o?: Parameters<ThoughtLogger["log"]>[2]) { return this.log("OBSERVE", c, o); }
  reflect(c: string, o?: Parameters<ThoughtLogger["log"]>[2]) { return this.log("REFLECT", c, o); }

  export(): ThoughtTimeline {
    this.finishedAt = this.finishedAt ?? Date.now();
    return {
      chains: Array.from(this.chains.values()),
      entries: [...this.entries],
      startedAt: this.startedAt,
      finishedAt: this.finishedAt,
      durationMs: this.finishedAt - this.startedAt,
    };
  }

  finish(): ThoughtTimeline {
    this.finishedAt = Date.now();
    for (const c of this.chains.values()) if (c.finishedAt === null) c.finishedAt = this.finishedAt!;
    return this.export();
  }

  format(): string {
    const lines: string[] = [];
    for (const chain of this.export().chains) {
      const ind = "  ".repeat(this._chainDepth(chain.id));
      const dur = chain.finishedAt !== null ? `${chain.finishedAt - chain.startedAt}ms` : "open";
      lines.push(`${ind}[chain:${chain.label}] (${dur})`);
      for (const e of chain.entries) lines.push(`${"  ".repeat(e.depth + 1)}[${e.category}] ${e.content}`);
    }
    return lines.join("\n");
  }

  reset(): void {
    this.chains.clear(); this.entries = [];
    this.activeChainId = null; this.startedAt = Date.now(); this.finishedAt = null; _seq = 0;
  }

  private _defaultChain(): string { return this.startChain("default"); }
  private _chainDepth(chainId: string): number {
    let depth = 0;
    let cur = this.chains.get(chainId);
    while (cur?.parentChainId) { depth++; cur = this.chains.get(cur.parentChainId); }
    return depth;
  }
}

export const thoughtLogger = new ThoughtLogger();
