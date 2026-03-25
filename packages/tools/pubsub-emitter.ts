/**
 * Typed publish-subscribe event emitter with wildcard topic filtering,
 * once listeners, async emit, and event history replay.
 */

export type TopicPattern = string;
export type Handler<T = unknown> = (event: T, topic: string) => void | Promise<void>;

interface Subscription {
  pattern: TopicPattern;
  handler: Handler;
  once: boolean;
}

interface HistoryEntry<T = unknown> {
  topic: string;
  event: T;
  timestamp: number;
}

function matchTopic(pattern: TopicPattern, topic: string): boolean {
  if (pattern === "#") return true;
  const pp = pattern.split(".");
  const tp = topic.split(".");
  if (pp.length !== tp.length) return false;
  return pp.every((p, i) => p === "*" || p === tp[i]);
}

export class PubSub<EventMap extends Record<string, unknown> = Record<string, unknown>> {
  private subs: Map<string, Subscription[]> = new Map();
  private history: HistoryEntry[] = [];
  private historyLimit: number;
  private id = 0;

  constructor(options: { historyLimit?: number } = {}) {
    this.historyLimit = options.historyLimit ?? 100;
  }

  subscribe<K extends keyof EventMap & string>(
    pattern: K | TopicPattern,
    handler: Handler<EventMap[K]>,
    options: { once?: boolean } = {}
  ): () => void {
    const key = String(++this.id);
    this.subs.set(key, [{ pattern: pattern as string, handler: handler as Handler, once: options.once ?? false }]);
    return () => this.subs.delete(key);
  }

  once<K extends keyof EventMap & string>(pattern: K | TopicPattern, handler: Handler<EventMap[K]>): () => void {
    return this.subscribe(pattern, handler, { once: true });
  }

  unsubscribeAll(pattern?: TopicPattern): void {
    if (!pattern) { this.subs.clear(); return; }
    for (const [k, list] of this.subs) {
      const rem = list.filter((s) => s.pattern !== pattern);
      rem.length === 0 ? this.subs.delete(k) : this.subs.set(k, rem);
    }
  }

  async emit<K extends keyof EventMap & string>(topic: K, event: EventMap[K]): Promise<void> {
    this.history.push({ topic: topic as string, event, timestamp: Date.now() });
    if (this.history.length > this.historyLimit) this.history.shift();
    const del: string[] = [];
    const ps: Promise<void>[] = [];
    for (const [k, list] of this.subs) {
      const rem: Subscription[] = [];
      for (const s of list) {
        if (matchTopic(s.pattern, topic as string)) {
          const r = s.handler(event, topic as string);
          if (r instanceof Promise) ps.push(r);
          if (!s.once) rem.push(s);
        } else { rem.push(s); }
      }
      rem.length === 0 ? del.push(k) : this.subs.set(k, rem);
    }
    del.forEach((k) => this.subs.delete(k));
    await Promise.all(ps);
  }

  replay(pattern: TopicPattern, handler: Handler, options: { limit?: number } = {}): void {
    const limit = options.limit ?? this.history.length;
    this.history.filter((e) => matchTopic(pattern, e.topic)).slice(-limit).forEach((e) => handler(e.event, e.topic));
  }

  getHistory(pattern?: TopicPattern): HistoryEntry[] {
    return pattern ? this.history.filter((e) => matchTopic(pattern, e.topic)) : [...this.history];
  }

  get subscriptionCount(): number {
    let n = 0;
    for (const list of this.subs.values()) n += list.length;
    return n;
  }

  clearHistory(): void { this.history = []; }
}
